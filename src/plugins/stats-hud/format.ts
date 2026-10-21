// Number formats of v0's bubbles (petween-desktop bubbles/styles.ts).

/** 12s · 3:05 · 1h20m */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, ms) / 1000;
  if (totalSeconds < 60) return `${Math.floor(totalSeconds)}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.floor(totalSeconds % 60);
  if (minutes < 60) return `${minutes}:${String(seconds).padStart(2, '0')}`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${minutes % 60}m`;
}

/** +40 −3 行 · 无变化 · ±? 行 (null = counts unknown) */
export function formatLines(added: number | null, removed: number | null): string {
  if (added === null && removed === null) return '±? 行';
  const parts: string[] = [];
  if (added !== null && added !== 0) parts.push(`+${added}`);
  if (removed !== null && removed !== 0) parts.push(`−${removed}`);
  if (parts.length === 0) return '无变化';
  return `${parts.join(' ')} 行`;
}
