/**
 * Minimal WAV helpers shared by the browser (encoding what the microphone captured)
 * and the server (decoding uploads for the local Whisper engine). No Node or DOM APIs.
 */

export interface DecodedWav {
  sampleRate: number;
  channels: number;
  /** Mono mix-down, samples in [-1, 1]. */
  samples: Float32Array;
  durationMs: number;
}

export function mergeChunks(chunks: Float32Array[]): Float32Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Float32Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

/** Linear-interpolation resampler, good enough for speech going to a 16 kHz model. */
export function resample(samples: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate || samples.length === 0) return samples;
  const ratio = fromRate / toRate;
  const outLength = Math.max(1, Math.round(samples.length / ratio));
  const out = new Float32Array(outLength);
  for (let i = 0; i < outLength; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(i0 + 1, samples.length - 1);
    const frac = pos - i0;
    out[i] = samples[i0] * (1 - frac) + samples[i1] * frac;
  }
  return out;
}

function writeAscii(view: DataView, offset: number, text: string) {
  for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
}

/** Encode mono float samples as 16-bit PCM WAV. */
export function encodeWav(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const bytesPerSample = 2;
  const dataLength = samples.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataLength);
  const view = new DataView(buffer);
  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataLength, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true);
  view.setUint16(32, bytesPerSample, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, 'data');
  view.setUint32(40, dataLength, true);
  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }
  return buffer;
}

function readAscii(view: DataView, offset: number, length: number): string {
  let s = '';
  for (let i = 0; i < length; i++) s += String.fromCharCode(view.getUint8(offset + i));
  return s;
}

/** Decode a PCM (8/16/24/32-bit int) or 32-bit float WAV into a mono float buffer. */
export function decodeWav(input: ArrayBuffer | Uint8Array): DecodedWav {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 12 || readAscii(view, 0, 4) !== 'RIFF' || readAscii(view, 8, 4) !== 'WAVE') {
    throw new Error('Not a WAV file');
  }
  let format = 0;
  let channels = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let dataOffset = -1;
  let dataLength = 0;
  let pos = 12;
  while (pos + 8 <= bytes.byteLength) {
    const id = readAscii(view, pos, 4);
    const size = view.getUint32(pos + 4, true);
    const body = pos + 8;
    if (id === 'fmt ') {
      format = view.getUint16(body, true);
      channels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bitsPerSample = view.getUint16(body + 14, true);
      if (format === 0xfffe && size >= 26) format = view.getUint16(body + 24, true); // WAVE_FORMAT_EXTENSIBLE
    } else if (id === 'data') {
      dataOffset = body;
      dataLength = Math.min(size, bytes.byteLength - body);
      break;
    }
    pos = body + size + (size % 2);
  }
  if (dataOffset < 0 || channels === 0 || sampleRate === 0) throw new Error('Malformed WAV: missing fmt or data chunk');
  const isFloat = format === 3;
  if (!isFloat && format !== 1) throw new Error(`Unsupported WAV format ${format}`);
  if (![8, 16, 24, 32].includes(bitsPerSample)) throw new Error(`Unsupported bit depth ${bitsPerSample}`);
  const bytesPerSample = bitsPerSample / 8;
  const frameCount = Math.floor(dataLength / (bytesPerSample * channels));
  const samples = new Float32Array(frameCount);
  for (let frame = 0; frame < frameCount; frame++) {
    let sum = 0;
    for (let ch = 0; ch < channels; ch++) {
      const at = dataOffset + (frame * channels + ch) * bytesPerSample;
      let v: number;
      if (isFloat) v = view.getFloat32(at, true);
      else if (bitsPerSample === 8) v = (view.getUint8(at) - 128) / 128;
      else if (bitsPerSample === 16) v = view.getInt16(at, true) / 0x8000;
      else if (bitsPerSample === 24) {
        const raw = view.getUint8(at) | (view.getUint8(at + 1) << 8) | (view.getUint8(at + 2) << 16);
        v = (raw & 0x800000 ? raw - 0x1000000 : raw) / 0x800000;
      } else v = view.getInt32(at, true) / 0x80000000;
      sum += v;
    }
    samples[frame] = sum / channels;
  }
  return { sampleRate, channels, samples, durationMs: Math.round((frameCount / sampleRate) * 1000) };
}
