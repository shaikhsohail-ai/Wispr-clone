import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Dictation, DictationPage, DictationPatch, NewDictation, Stats } from '../src/shared/types.js';
import { countWords, timeSavedMs, wordsPerMinute } from '../src/shared/text.js';

export interface ListOptions {
  q?: string;
  limit?: number;
  offset?: number;
}

interface StoreFile {
  version: 1;
  dictations: Dictation[];
}

/**
 * Dictation history persisted as a single JSON file (newest first in memory).
 * Writes are debounced and atomic (temp file + rename) so a crash never leaves a half-written history.
 * With no file path the store is in-memory only, which the tests use.
 */
export class DictationStore {
  private items: Dictation[] = [];
  private saveTimer: NodeJS.Timeout | null = null;
  private pendingSave: Promise<void> | null = null;
  private dirty = false;

  private constructor(private readonly filePath: string | null) {}

  static async open(filePath: string | null): Promise<DictationStore> {
    const store = new DictationStore(filePath);
    if (filePath) {
      try {
        const raw = await readFile(filePath, 'utf8');
        const parsed = JSON.parse(raw) as Partial<StoreFile>;
        store.items = Array.isArray(parsed.dictations) ? parsed.dictations.filter(isDictation) : [];
        store.items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw new Error(`Could not read dictation history at ${filePath}: ${(err as Error).message}`, { cause: err });
        }
      }
    }
    return store;
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
      durationMs: Math.max(0, Math.round(input.durationMs || 0)),
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

  /** Wait for any pending write to land. Call before process exit. */
  async flush(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (this.dirty) await this.writeNow();
    await this.pendingSave;
  }

  private scheduleSave() {
    this.dirty = true;
    if (!this.filePath || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.writeNow();
    }, 150);
  }

  private async writeNow(): Promise<void> {
    if (!this.filePath) {
      this.dirty = false;
      return;
    }
    // Serialise writes so a slow disk never interleaves two snapshots.
    const previous = this.pendingSave ?? Promise.resolve();
    const run = previous.then(async () => {
      if (!this.dirty) return;
      this.dirty = false;
      const payload: StoreFile = { version: 1, dictations: this.items };
      const tmp = `${this.filePath}.${process.pid}.tmp`;
      await mkdir(dirname(this.filePath!), { recursive: true });
      await writeFile(tmp, JSON.stringify(payload, null, 2), 'utf8');
      await rename(tmp, this.filePath!);
    });
    this.pendingSave = run.catch((err) => {
      this.dirty = true;
      console.error('[store] failed to save dictation history:', err);
    });
    return this.pendingSave;
  }
}

function isDictation(value: unknown): value is Dictation {
  if (!value || typeof value !== 'object') return false;
  const d = value as Record<string, unknown>;
  return typeof d.id === 'string' && typeof d.text === 'string' && typeof d.createdAt === 'string';
}
