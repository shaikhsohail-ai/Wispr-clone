import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DictationStore, MAX_DURATION_MS } from './store.js';

async function waitFor(check: () => boolean, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 5));
  }
}

const sample = (text: string, durationMs = 10_000) => ({
  text,
  rawText: `raw ${text}`,
  engine: 'mock' as const,
  language: 'en',
  durationMs,
});

describe('DictationStore (memory)', () => {
  it('creates, lists newest first, searches, updates, deletes and counts', async () => {
    const store = await DictationStore.open(null);
    const a = store.create(sample('alpha beta'));
    await new Promise((r) => setTimeout(r, 2));
    const b = store.create(sample('gamma delta', 30_000));
    expect(store.list().items.map((d) => d.id)).toEqual([b.id, a.id]);
    expect(store.list({ q: 'ALPHA' }).items).toHaveLength(1);
    expect(store.list({ q: 'raw gamma' }).items).toHaveLength(1);
    expect(store.list({ q: 'alpha gamma' }).total).toBe(0);
    expect(store.list({ limit: 1 }).items).toHaveLength(1);
    expect(store.list({ limit: 1, offset: 1 }).items[0].id).toBe(a.id);
    expect(a.wordCount).toBe(2);
    expect(a.polished).toBe(false);

    const updated = store.update(a.id, { text: 'alpha beta gamma', polished: true });
    expect(updated?.wordCount).toBe(3);
    expect(updated?.polished).toBe(true);
    expect(store.update('missing', { text: 'x' })).toBeUndefined();

    const stats = store.stats();
    expect(stats.count).toBe(2);
    expect(stats.words).toBe(5);
    expect(stats.totalDurationMs).toBe(40_000);
    expect(stats.averageWpm).toBeCloseTo(7.5, 1);
    expect(stats.timeSavedMs).toBe(0);

    expect(store.delete(a.id)).toBe(true);
    expect(store.delete(a.id)).toBe(false);
    expect(store.clear()).toBe(1);
    expect(store.stats().count).toBe(0);
  });
});

describe('DictationStore (file)', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'wispr-store-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('persists across reopen and writes atomically', async () => {
    const file = join(dir, 'nested', 'dictations.json');
    const store = await DictationStore.open(file);
    const created = store.create(sample('persist me'));
    await store.flush();
    const files = await readdir(join(dir, 'nested'));
    expect(files).toEqual(['dictations.json']);
    const parsed = JSON.parse(await readFile(file, 'utf8'));
    expect(parsed.version).toBe(1);
    expect(parsed.dictations[0].id).toBe(created.id);

    const reopened = await DictationStore.open(file);
    expect(reopened.get(created.id)?.text).toBe('persist me');
  });

  it('coalesces rapid writes and survives a flush with nothing pending', async () => {
    const file = join(dir, 'dictations.json');
    const store = await DictationStore.open(file);
    for (let i = 0; i < 20; i++) store.create(sample(`item ${i}`));
    await store.flush();
    await store.flush();
    const reopened = await DictationStore.open(file);
    expect(reopened.list({ limit: 100 }).total).toBe(20);
  });

  it('rejects a corrupt history file instead of silently discarding it', async () => {
    const file = join(dir, 'dictations.json');
    await writeFile(file, '{ not json');
    await expect(DictationStore.open(file)).rejects.toThrow(/Could not read/);
  });

  it('ignores malformed entries and fills in missing or mistyped fields', async () => {
    const file = join(dir, 'dictations.json');
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        dictations: [
          { id: 'ok', text: 'fine', createdAt: '2024-01-01T00:00:00.000Z' },
          {
            id: 'typed',
            text: 'two words',
            createdAt: '2024-01-02T00:00:00.000Z',
            wordCount: '12',
            durationMs: 'soon',
            engine: 'nope',
            language: '',
            polished: 'yes',
          },
          { id: 'huge', text: 'x', createdAt: '2024-01-03T00:00:00.000Z', durationMs: 1e308, wordCount: 1 },
          { id: 'blank', text: '   ', createdAt: '2024-01-04T00:00:00.000Z' },
          { nope: true },
          4,
        ],
      }),
    );
    const store = await DictationStore.open(file);
    expect(store.all().map((d) => d.id)).toEqual(['huge', 'typed', 'ok']);
    expect(store.get('ok')).toEqual({
      id: 'ok',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
      text: 'fine',
      rawText: 'fine',
      engine: 'webspeech',
      language: 'auto',
      durationMs: 0,
      wordCount: 1,
      polished: false,
    });
    expect(store.get('typed')).toMatchObject({ wordCount: 2, durationMs: 0, engine: 'webspeech', language: 'auto', polished: false });
    expect(store.get('huge')?.durationMs).toBe(MAX_DURATION_MS);
    const stats = store.stats();
    expect(Object.values(stats).every(Number.isFinite)).toBe(true);
    expect(stats).toMatchObject({ count: 3, words: 4, totalDurationMs: MAX_DURATION_MS });
    expect(store.list({ q: 'undefined' }).total).toBe(0);
  });

  it('caps durations so the aggregate stats stay finite', async () => {
    const store = await DictationStore.open(null);
    store.create(sample('a', 1e308));
    store.create(sample('b', 1e308));
    expect(store.stats().totalDurationMs).toBe(2 * MAX_DURATION_MS);
    expect(store.create(sample('c', -5)).durationMs).toBe(0);
  });

  it('refuses to open when the history directory cannot be written', async () => {
    const blocker = join(dir, 'blocker');
    await writeFile(blocker, 'not a directory');
    await expect(DictationStore.open(join(blocker, 'dictations.json'))).rejects.toThrow(/Cannot write dictation history/);
  });

  it('retries a failed save with backoff until the disk is writable again', async () => {
    const dataDir = join(dir, 'history');
    const file = join(dataDir, 'dictations.json');
    const store = await DictationStore.open(file, { saveDelayMs: 10, retryDelayMs: 20 });
    await rm(dataDir, { recursive: true, force: true });
    await writeFile(dataDir, 'in the way'); // every mkdir and rename now fails
    const created = store.create(sample('survive me'));
    await waitFor(() => store.lastSaveError !== null);
    await new Promise((r) => setTimeout(r, 30)); // at least one retry has fired meanwhile
    expect(store.lastSaveError).not.toBeNull();
    await rm(dataDir, { force: true });
    await waitFor(() => store.lastSaveError === null); // a retry lands without any further mutation
    const reopened = await DictationStore.open(file);
    expect(reopened.get(created.id)?.text).toBe('survive me');
  });

  it('rejects flush while the fault persists and keeps the data for a later flush', async () => {
    const dataDir = join(dir, 'history');
    const file = join(dataDir, 'dictations.json');
    const store = await DictationStore.open(file, { saveDelayMs: 10_000 });
    await rm(dataDir, { recursive: true, force: true });
    await writeFile(dataDir, 'in the way');
    const first = store.create(sample('first'));
    await expect(store.flush()).rejects.toThrow();
    expect(store.lastSaveError).not.toBeNull();
    await rm(dataDir, { force: true });
    const second = store.create(sample('second'));
    await store.flush();
    expect(store.lastSaveError).toBeNull();
    const reopened = await DictationStore.open(file);
    expect(reopened.all().map((d) => d.id)).toEqual([second.id, first.id]);
  });
});
