export type Align = 'left' | 'right';
export type Column = { header: string; align?: Align };

/** Render an ASCII table. Numeric columns should be pre-formatted by the caller. */
export function table(cols: Column[], rows: string[][]): string {
  const widths = cols.map((c, i) =>
    Math.max(c.header.length, ...rows.map((r) => (r[i] ?? '').length)),
  );

  const pad = (s: string, w: number, align: Align) =>
    align === 'right' ? s.padStart(w) : s.padEnd(w);

  const renderRow = (row: string[]) =>
    row.map((cell, i) => pad(cell ?? '', widths[i], cols[i].align ?? 'left')).join('  ');

  const header = renderRow(cols.map((c) => c.header));
  const sep = widths.map((w) => '─'.repeat(w)).join('  ');
  return [header, sep, ...rows.map(renderRow)].join('\n');
}

export function formatTokens(n: number): string {
  return n.toLocaleString('en-US');
}

export function formatDollars(n: number): string {
  if (n >= 100) return `$${n.toFixed(2)}`;
  if (n >= 1) return `$${n.toFixed(2)}`;
  if (n >= 0.01) return `$${n.toFixed(4)}`;
  if (n > 0) return `$${n.toFixed(6)}`;
  return '$0.00';
}

export function formatDuration(startIso: string, endIso: string | null): string {
  const start = new Date(startIso).getTime();
  const end = endIso === null ? Date.now() : new Date(endIso).getTime();
  let ms = Math.max(0, end - start);
  const d = Math.floor(ms / 86_400_000);
  ms -= d * 86_400_000;
  const h = Math.floor(ms / 3_600_000);
  ms -= h * 3_600_000;
  const m = Math.floor(ms / 60_000);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}
