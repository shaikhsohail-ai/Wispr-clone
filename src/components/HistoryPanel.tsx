import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { relativeTime } from '../lib/time';
import { formatDuration } from '../shared/text';
import { ENGINE_SHORT_LABELS, type Dictation } from '../shared/types';

interface Props {
  version: number;
  selectedId: string | null;
  onSelect: (dictation: Dictation) => void;
  onCopy: (text: string) => void;
  onChanged: () => void;
  notify: (message: string, kind?: 'info' | 'success' | 'error') => void;
}

const PAGE = 50;

export function HistoryPanel({ version, selectedId, onSelect, onCopy, onChanged, notify }: Props) {
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  // One state object per fetch so "loading" is derived (key mismatch) instead of set from inside the effect.
  const [page, setPage] = useState<{ key: string; items: Dictation[]; total: number; offline: boolean } | null>(null);
  const pageKey = `${version}|${debounced}`;
  const loading = page?.key !== pageKey;
  const items = page?.items ?? [];
  const total = page?.total ?? 0;
  const offline = page?.offline ?? false;
  const setItems = (update: (list: Dictation[]) => Dictation[]) => setPage((p) => (p ? { ...p, items: update(p.items) } : p));
  const setTotal = (update: (t: number) => number) => setPage((p) => (p ? { ...p, total: update(p.total) } : p));

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(query.trim()), 200);
    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    let cancelled = false;
    api
      .listDictations({ q: debounced, limit: PAGE })
      .then((result) => {
        if (!cancelled) setPage({ key: pageKey, items: result.items, total: result.total, offline: false });
      })
      .catch(() => {
        if (!cancelled) setPage((p) => ({ key: pageKey, items: p?.items ?? [], total: p?.total ?? 0, offline: true }));
      });
    return () => {
      cancelled = true;
    };
  }, [debounced, pageKey]);

  const loadMore = async () => {
    try {
      const page = await api.listDictations({ q: debounced, limit: PAGE, offset: items.length });
      setItems((list) => [...list, ...page.items]);
      setTotal(() => page.total);
    } catch (err) {
      notify(`Could not load more: ${(err as Error).message}`, 'error');
    }
  };

  const remove = async (id: string) => {
    try {
      await api.deleteDictation(id);
      setItems((list) => list.filter((d) => d.id !== id));
      setTotal((t) => Math.max(0, t - 1));
      onChanged();
    } catch (err) {
      notify(`Could not delete: ${(err as Error).message}`, 'error');
    }
  };

  const clearAll = async () => {
    if (!window.confirm('Delete every dictation? This cannot be undone.')) return;
    try {
      const { removed } = await api.clearDictations();
      notify(`Deleted ${removed} dictation${removed === 1 ? '' : 's'}`, 'success');
      onChanged();
    } catch (err) {
      notify(`Could not clear history: ${(err as Error).message}`, 'error');
    }
  };

  return (
    <div className="history" data-testid="history">
      <div className="history-toolbar">
        <input
          type="search"
          className="input"
          placeholder="Search dictations…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          aria-label="Search dictations"
          data-testid="history-search"
        />
        <div className="history-menu">
          <span className="history-menu-label">Export</span>
          <a className="btn btn-small" href={api.exportUrl('txt')} download data-testid="export-txt">
            .txt
          </a>
          <a className="btn btn-small" href={api.exportUrl('md')} download>
            .md
          </a>
          <a className="btn btn-small" href={api.exportUrl('json')} download>
            .json
          </a>
          <span className="spacer" />
          <button type="button" className="btn btn-small btn-danger" onClick={clearAll} disabled={total === 0} data-testid="clear-all">
            Clear all
          </button>
        </div>
      </div>

      {offline ? (
        <p className="muted">History is unavailable while the server is offline.</p>
      ) : loading && items.length === 0 ? (
        <p className="muted">Loading…</p>
      ) : items.length === 0 ? (
        <p className="muted" data-testid="history-empty">
          {debounced ? 'No dictations match that search.' : 'No dictations yet. Your first one will appear here.'}
        </p>
      ) : (
        <ul className="history-list" data-testid="history-list">
          {items.map((d) => (
            <li key={d.id} className={`history-item${d.id === selectedId ? ' selected' : ''}`} data-testid="history-item">
              <button
                type="button"
                className="history-item-body"
                onClick={() => onSelect(d)}
                aria-label={`Open dictation from ${relativeTime(d.createdAt)}`}
              >
                <span className="history-text">{d.text}</span>
                <span className="history-meta">
                  <span>{relativeTime(d.createdAt)}</span>
                  <span>·</span>
                  <span>{d.wordCount} words</span>
                  {d.durationMs > 0 && (
                    <>
                      <span>·</span>
                      <span>{formatDuration(d.durationMs)}</span>
                    </>
                  )}
                  <span>·</span>
                  <span>{ENGINE_SHORT_LABELS[d.engine]}</span>
                  {d.polished && <span className="chip chip-accent">polished</span>}
                </span>
              </button>
              <span className="history-item-actions">
                <button type="button" className="icon-btn" title="Copy" aria-label="Copy dictation" onClick={() => onCopy(d.text)}>
                  ⧉
                </button>
                <button type="button" className="icon-btn danger" title="Delete" aria-label="Delete dictation" onClick={() => remove(d.id)}>
                  ✕
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
      {items.length < total && (
        <button type="button" className="btn btn-ghost" onClick={loadMore}>
          Load more ({total - items.length} left)
        </button>
      )}
    </div>
  );
}
