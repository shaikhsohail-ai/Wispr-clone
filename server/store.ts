import { access, constants, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Dictation, DictationPage, DictationPatch, EngineId, NewDictation, Stats } from '../src/shared/types.js';
import { countWords, timeSavedMs, wordsPerMinute } from '../src/shared/text.js';
import { ENGINE_IDS } from './engines/types.js';

export interface ListOptions {
  q?: string;
  limit?: number;
  offset?: number;
}

export interface StoreOptions {
  /** Debounce between a change and the write that persists it. */
  saveDelayMs?: number;
  /** Delay before the first retry after a failed save; doubles on every further failure up to RETRY_MAX_MS. */
  retryDelayMs?: number;
}

/** Upper bound for one dictation's duration (24 h) so the aggregate stats always stay finite. */
export const MAX_DURATION_MS = 24 * 60 * 60 * 1000;

const SAVE_DELAY_MS = 150;
const RETRY_MIN_MS = 2_000;
const RETRY_MAX_MS = 60_000;

interface StoreFile {
  version: 1;
  dictations: Dictation[];
}

/**
 * Dictation history persisted as a single JSON file (newest first in memory).
 * Writes are debounced and atomic (temp file + rename) so a crash never leaves a half-written history.
 * A failed write is retried with backoff and reported through `lastSaveError`; `flush()` rejects when
 * the final attempt fails so shutdown can report the loss. With no file path the store is in-memory
 * only, which the tests use.
 */
export class DictationStore {
  private items: Dictation[] = [];
  private saveTimer: NodeJS.Timeout | null = null;
  private pendingSave: Promise<void> | null = null;
  private dirty = false;
  private flushing = false;
  private saveError: Error | null = null;
  private retryDelay: number;
  private readonly saveDelayMs: number;
  private readonly retryMinMs: number;

  private constructor(
    private readonly filePath: string | null,
    options: StoreOptions,
  ) {
    this.saveDelayMs = options.saveDelayMs ?? SAVE_DELAY_MS;
    this.retryMinMs = options.retryDelayMs ?? RETRY_MIN_MS;
    this.retryDelay = this.retryMinMs;
  }

  static async open(filePath: string | null, options: StoreOptions = {}): Promise<DictationStore> {
    const store = new DictationStore(filePath, options);
    if (filePath) {
      // Fail at start-up rather than after dictations have been accepted when the history cannot be written.
      const dir = dirname(filePath);
      try {
        await mkdir(dir, { recursive: true });
        await access(dir, constants.W_OK);
      } catch (err) {
        throw new Error(`Cannot write dictation history to ${dir}: ${(err as Error).message}`, { cause: err });
      }
      try {
        const raw = await readFile(filePath, 'utf8');
        const parsed = JSON.parse(raw) as Partial<StoreFile>;
        const rows = Array.isArray(parsed.dictations) ? parsed.dictations : [];
        let repaired = 0;
        for (const row of rows) {
          const result = normaliseDictation(row);
          if (!result) continue;
          store.items.push(result.dictation);
          if (result.repaired) repaired += 1;
        }
        const dropped = rows.length - store.items.length;
        if (dropped || repaired) {
          console.warn(`[store] ${filePath}: dropped ${dropped} malformed and filled in ${repaired} incomplete dictation(s)`);
        }
        store.items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw new Error(`Could not read dictation history at ${filePath}: ${(err as Error).message}`, { cause: err });
        }
      }
    }
    return store;
  }

  /** The error from the latest failed save, or null once the history is safely on disk again. */
  get lastSaveError(): Error | null {
    return this.saveError;
  }

  all(): Dictation[] {
    return [...this.items];
  }

  list({ q = '', limit = 50, offset = 0 }: ListOptions = {}): DictationPage {
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
    const matches = terms.length
      ? this.items.filter((d) => {
          const hay = `${d.text}\n${d.rawText}`.toLowerCase();
          return terms.every((t) => hay.includes(t));
        })
      : this.items;
    const safeLimit = Math.min(Math.max(1, Math.floor(limit)), 500);
    const safeOffset = Math.max(0, Math.floor(offset));
    return { items: matches.slice(safeOffset, safeOffset + safeLimit), total: matches.length };
  }

  get(id: string): Dictation | undefined {
    return this.items.find((d) => d.id === id);
  }

  create(input: NewDictation): Dictation {
    const now = new Date().toISOString();
    const text = input.text.trim();
    const dictation: Dictation = {
      id: randomUUID(),
      createdAt: now,
      updatedAt: now,
      text,
      rawText: (input.rawText ?? text).trim(),
      engine: input.engine,
      language: input.language || 'auto',
      durationMs: clampDuration(input.durationMs),
      wordCount: countWords(text),
      polished: Boolean(input.polished),
    };
    this.items.unshift(dictation);
    this.scheduleSave();
    return dictation;
  }

  update(id: string, patch: DictationPatch): Dictation | undefined {
    const existing = this.get(id);
    if (!existing) return undefined;
    if (typeof patch.text === 'string') {
      existing.text = patch.text.trim();
      existing.wordCount = countWords(existing.text);
    }
    if (typeof patch.polished === 'boolean') existing.polished = patch.polished;
    existing.updatedAt = new Date().toISOString();
    this.scheduleSave();
    return existing;
  }

  delete(id: string): boolean {
    const before = this.items.length;
    this.items = this.items.filter((d) => d.id !== id);
    const removed = this.items.length !== before;
    if (removed) this.scheduleSave();
    return removed;
  }

  clear(): number {
    const removed = this.items.length;
    this.items = [];
    if (removed) this.scheduleSave();
    return removed;
  }

  stats(): Stats {
    const count = this.items.length;
    const words = this.items.reduce((n, d) => n + d.wordCount, 0);
    const totalDurationMs = this.items.reduce((n, d) => n + d.durationMs, 0);
    const saved = this.items.reduce((n, d) => n + timeSavedMs(d.wordCount, d.durationMs), 0);
    return { count, words, totalDurationMs, averageWpm: wordsPerMinute(words, totalDurationMs), timeSavedMs: saved };
  }

  /**
   * Write any unsaved changes now. Call before process exit. Rejects with the underlying error when the
   * history could not be written, in which case the changes stay in memory and the store stays dirty.
   */
  async flush(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.flushing = true;
    try {
      // Let an in-flight write finish first; if it failed the store is dirty again and gets one more attempt.
      await this.pendingSave;
      if (this.dirty) await this.writeNow();
    } finally {
      this.flushing = false;
    }
  }

  private scheduleSave() {
    this.dirty = true;
    if (!this.filePath || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.writeNow().catch(() => undefined);
    }, this.saveDelayMs);
  }

  /** Re-arm the timer after a failed save with growing backoff, so a broken disk neither loses data nor floods the log. */
  private scheduleRetry() {
    if (!this.filePath || this.flushing || this.saveTimer) return;
    const delay = this.retryDelay;
    this.retryDelay = Math.min(this.retryDelay * 2, RETRY_MAX_MS);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.writeNow().catch(() => undefined);
    }, delay);
  }

  /** Returns the un-swallowed write so direct callers (flush) see failures; the timer paths catch it themselves. */
  private writeNow(): Promise<void> {
    const filePath = this.filePath;
    if (!filePath) {
      this.dirty = false;
      return Promise.resolve();
    }
    // Serialise writes so a slow disk never interleaves two snapshots.
    const previous = this.pendingSave ?? Promise.resolve();
    const run = previous.then(async () => {
      if (!this.dirty) return;
      this.dirty = false;
      const payload: StoreFile = { version: 1, dictations: this.items };
      const tmp = `${filePath}.${process.pid}.tmp`;
      try {
        await mkdir(dirname(filePath), { recursive: true });
        await writeFile(tmp, JSON.stringify(payload, null, 2), 'utf8');
        await rename(tmp, filePath);
      } catch (err) {
        this.dirty = true;
        await unlink(tmp).catch(() => undefined);
        throw err;
      }
      if (this.saveError) console.log(`[store] dictation history saved to ${filePath} after earlier failures`);
      this.saveError = null;
      this.retryDelay = this.retryMinMs;
    });
    this.pendingSave = run.catch((err: unknown) => {
      const error = err instanceof Error ? err : new Error(String(err));
      if (error.message !== this.saveError?.message) {
        console.error(`[store] failed to save dictation history to ${filePath}, will retry: ${error.message}`);
      }
      this.saveError = error;
      this.scheduleRetry();
    });
    return run;
  }
}

/** Clamp a client-supplied duration to [0, MAX_DURATION_MS]; anything that is not a finite number becomes 0. */
export function clampDuration(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(MAX_DURATION_MS, Math.max(0, Math.round(value))) : 0;
}

/**
 * Accept any entry that still carries the user's text (id, non-empty text, createdAt) and fill in whatever
 * else is missing or mistyped, so a hand-edited or older-schema file can never produce NaN stats or
 * an "undefined" search index. Entries without those three fields are dropped.
 */
function normaliseDictation(value: unknown): { dictation: Dictation; repaired: boolean } | null {
  if (!value || typeof value !== 'object') return null;
  const d = value as Record<string, unknown>;
  if (typeof d.id !== 'string' || typeof d.text !== 'string' || typeof d.createdAt !== 'string') return null;
  const text = d.text.trim();
  if (!text) return null;
  const dictation: Dictation = {
    id: d.id,
    createdAt: d.createdAt,
    updatedAt: typeof d.updatedAt === 'string' ? d.updatedAt : d.createdAt,
    text,
    rawText: typeof d.rawText === 'string' ? d.rawText : text,
    engine: ENGINE_IDS.includes(d.engine as EngineId) ? (d.engine as EngineId) : 'webspeech',
    language: typeof d.language === 'string' && d.language ? d.language : 'auto',
    durationMs: clampDuration(d.durationMs),
    wordCount: typeof d.wordCount === 'number' && Number.isFinite(d.wordCount) ? Math.max(0, Math.round(d.wordCount)) : countWords(text),
    polished: d.polished === true,
  };
  const repaired = (Object.keys(dictation) as Array<keyof Dictation>).some((key) => dictation[key] !== d[key]);
  return { dictation, repaired };
}
