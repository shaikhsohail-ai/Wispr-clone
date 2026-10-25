import { describe, expect, it } from 'vitest';
import { decodeWav, encodeWav, mergeChunks, resample } from './wav.js';

function sine(samples: number, rate: number, hz = 440): Float32Array {
  const out = new Float32Array(samples);
  for (let i = 0; i < samples; i++) out[i] = 0.5 * Math.sin((2 * Math.PI * hz * i) / rate);
  return out;
}

describe('wav', () => {
  it('round-trips 16-bit PCM', () => {
    const input = sine(16_000, 16_000);
    const buffer = encodeWav(input, 16_000);
    expect(buffer.byteLength).toBe(44 + input.length * 2);
    const decoded = decodeWav(buffer);
    expect(decoded.sampleRate).toBe(16_000);
    expect(decoded.channels).toBe(1);
    expect(decoded.durationMs).toBe(1000);
    expect(decoded.samples.length).toBe(input.length);
    let maxError = 0;
    for (let i = 0; i < input.length; i++) maxError = Math.max(maxError, Math.abs(input[i] - decoded.samples[i]));
    expect(maxError).toBeLessThan(1e-3);
  });

  it('clamps out-of-range samples', () => {
    const decoded = decodeWav(encodeWav(new Float32Array([2, -2, 0]), 8000));
    expect(decoded.samples[0]).toBeCloseTo(1, 3);
    expect(decoded.samples[1]).toBeCloseTo(-1, 3);
    expect(decoded.samples[2]).toBe(0);
  });

  it('rejects non-WAV input', () => {
    expect(() => decodeWav(new Uint8Array([1, 2, 3]))).toThrow(/Not a WAV/);
    const bogus = new Uint8Array(encodeWav(new Float32Array(10), 8000));
    bogus.set([0x57, 0x41, 0x56, 0x58], 8); // "WAVX"
    expect(() => decodeWav(bogus)).toThrow(/Not a WAV/);
  });

  it('decodes stereo float32 by mixing down', () => {
    const frames = 4;
    const buffer = new ArrayBuffer(44 + frames * 2 * 4);
    const view = new DataView(buffer);
    const ascii = (offset: number, text: string) => [...text].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
    ascii(0, 'RIFF');
    view.setUint32(4, 36 + frames * 8, true);
    ascii(8, 'WAVE');
    ascii(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 3, true);
    view.setUint16(22, 2, true);
    view.setUint32(24, 48_000, true);
    view.setUint32(28, 48_000 * 8, true);
    view.setUint16(32, 8, true);
    view.setUint16(34, 32, true);
    ascii(36, 'data');
    view.setUint32(40, frames * 8, true);
    const values = [
      [1, 0],
      [0.5, 0.5],
      [-1, 1],
      [0.25, -0.75],
    ];
    values.forEach(([l, r], i) => {
      view.setFloat32(44 + i * 8, l, true);
      view.setFloat32(48 + i * 8, r, true);
    });
    const decoded = decodeWav(buffer);
    expect(decoded.channels).toBe(2);
    expect(decoded.sampleRate).toBe(48_000);
    expect(Array.from(decoded.samples)).toEqual([0.5, 0.5, 0, -0.25]);
  });

  it('resamples with roughly the right length and preserves silence', () => {
    const input = sine(48_000, 48_000);
    const out = resample(input, 48_000, 16_000);
    expect(out.length).toBe(16_000);
    expect(resample(input, 48_000, 48_000)).toBe(input);
    expect(Array.from(resample(new Float32Array([0, 0, 0, 0]), 8000, 4000))).toEqual([0, 0]);
  });

  it('merges chunks in order', () => {
    const merged = mergeChunks([new Float32Array([1, 2]), new Float32Array([]), new Float32Array([3])]);
    expect(Array.from(merged)).toEqual([1, 2, 3]);
  });
});
