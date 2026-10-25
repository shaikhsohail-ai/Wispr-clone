import type {
  Dictation,
  DictationPage,
  DictationPatch,
  EngineId,
  HealthInfo,
  NewDictation,
  PolishRequest,
  PolishResult,
  Stats,
  TranscribeResult,
} from '../shared/types';

export class ApiRequestError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code?: string,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    throw new ApiRequestError(0, 'Cannot reach the Wispr Clone server. Is `npm run dev` running?', 'offline');
  }
  if (!res.ok) {
    let message = res.statusText || `Request failed (${res.status})`;
    let code: string | undefined;
    try {
      const body = (await res.json()) as { error?: string; code?: string };
      if (body.error) message = body.error;
      code = body.code;
    } catch {
      /* non-JSON error body */
    }
    throw new ApiRequestError(res.status, message, code);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

function json(method: string, body: unknown): RequestInit {
  return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

export const api = {
  health: () => request<HealthInfo>('/api/health'),

  transcribe: (wav: Blob, engine: EngineId, language: string, signal?: AbortSignal) =>
    request<TranscribeResult>(`/api/transcribe?engine=${encodeURIComponent(engine)}&language=${encodeURIComponent(language)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'audio/wav' },
      body: wav,
      signal,
    }),

  polish: (body: PolishRequest) => request<PolishResult>('/api/polish', json('POST', body)),

  listDictations: (params: { q?: string; limit?: number; offset?: number } = {}) => {
    const search = new URLSearchParams();
    if (params.q) search.set('q', params.q);
    if (params.limit) search.set('limit', String(params.limit));
    if (params.offset) search.set('offset', String(params.offset));
    const qs = search.toString();
    return request<DictationPage>(`/api/dictations${qs ? `?${qs}` : ''}`);
  },

  createDictation: (body: NewDictation) => request<Dictation>('/api/dictations', json('POST', body)),
  updateDictation: (id: string, patch: DictationPatch) =>
    request<Dictation>(`/api/dictations/${encodeURIComponent(id)}`, json('PATCH', patch)),
  deleteDictation: (id: string) => request<void>(`/api/dictations/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  clearDictations: () => request<{ removed: number }>('/api/dictations', { method: 'DELETE' }),
  stats: () => request<Stats>('/api/stats'),
  exportUrl: (format: 'txt' | 'md' | 'json') => `/api/dictations/export?format=${format}`,
};
