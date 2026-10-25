import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { formatDuration } from '../shared/text';
import type { Stats } from '../shared/types';

export function StatsBar({ version }: { version: number }) {
  const [stats, setStats] = useState<Stats | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .stats()
      .then((s) => {
        if (!cancelled) setStats(s);
      })
      .catch(() => {
        if (!cancelled) setStats(null);
      });
    return () => {
      cancelled = true;
    };
  }, [version]);

  const tiles = [
    { label: 'Dictations', value: stats ? String(stats.count) : '–', testId: 'stat-count' },
    { label: 'Words', value: stats ? stats.words.toLocaleString() : '–', testId: 'stat-words' },
    { label: 'Avg speed', value: stats && stats.averageWpm > 0 ? `${Math.round(stats.averageWpm)} wpm` : '–', testId: 'stat-wpm' },
    { label: 'Time saved', value: stats ? formatDuration(stats.timeSavedMs) : '–', testId: 'stat-saved' },
  ];

  return (
    <div className="stats" aria-label="Statistics">
      {tiles.map((t) => (
        <div key={t.label} className="stat">
          <span className="stat-value" data-testid={t.testId}>
            {t.value}
          </span>
          <span className="stat-label">{t.label}</span>
        </div>
      ))}
    </div>
  );
}
