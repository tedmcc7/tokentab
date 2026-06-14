import { Store } from '../../core/store/index.js';
import { priceEvent } from '../../core/pricing/index.js';
import type { PriceRow } from '../../core/types.js';
import { formatDollars, formatTokens, table } from '../format.js';

function localDayBoundsIso(now = new Date()): { from: string; to: string } {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { from: start.toISOString(), to: end.toISOString() };
}

export function runToday(): void {
  const store = new Store();
  const prices: PriceRow[] = store.getPrices();

  const { from, to } = localDayBoundsIso();
  const events = store.eventsInRange(from, to);

  if (events.length === 0) {
    console.log('No events today.');
    console.log('Run `tt ingest` to scan your local Claude Code logs.');
    store.close();
    return;
  }

  type Group = {
    repo: string;
    events: number;
    input: number;
    output: number;
    cache_write: number;
    cache_read: number;
    cost: number;
    unpriced_events: number;
  };
  const groups = new Map<string, Group>();

  for (const e of events) {
    const key = e.repo ?? '(unknown)';
    let g = groups.get(key);
    if (!g) {
      g = {
        repo: key,
        events: 0,
        input: 0,
        output: 0,
        cache_write: 0,
        cache_read: 0,
        cost: 0,
        unpriced_events: 0,
      };
      groups.set(key, g);
    }
    g.events++;
    g.input += e.input_tokens;
    g.output += e.output_tokens;
    g.cache_write += e.cache_write_tokens;
    g.cache_read += e.cache_read_tokens;
    const p = priceEvent(e, prices);
    if (p.priced) g.cost += p.cost;
    else g.unpriced_events++;
  }

  const rows = Array.from(groups.values()).sort((a, b) => b.cost - a.cost);

  const tableRows = rows.map((g) => [
    g.repo,
    String(g.events),
    formatTokens(g.input),
    formatTokens(g.output),
    formatTokens(g.cache_write),
    formatTokens(g.cache_read),
    g.unpriced_events === g.events
      ? '—'
      : g.unpriced_events > 0
        ? `${formatDollars(g.cost)} *`
        : formatDollars(g.cost),
  ]);

  const totals: Group = rows.reduce<Group>(
    (acc, g) => ({
      repo: 'TOTAL',
      events: acc.events + g.events,
      input: acc.input + g.input,
      output: acc.output + g.output,
      cache_write: acc.cache_write + g.cache_write,
      cache_read: acc.cache_read + g.cache_read,
      cost: acc.cost + g.cost,
      unpriced_events: acc.unpriced_events + g.unpriced_events,
    }),
    {
      repo: 'TOTAL',
      events: 0,
      input: 0,
      output: 0,
      cache_write: 0,
      cache_read: 0,
      cost: 0,
      unpriced_events: 0,
    },
  );

  tableRows.push([
    'TOTAL',
    String(totals.events),
    formatTokens(totals.input),
    formatTokens(totals.output),
    formatTokens(totals.cache_write),
    formatTokens(totals.cache_read),
    totals.unpriced_events > 0
      ? `${formatDollars(totals.cost)} *`
      : formatDollars(totals.cost),
  ]);

  const day = new Date().toISOString().slice(0, 10);
  console.log(`Today (${day}, local) — grouped by repo`);
  console.log();
  console.log(
    table(
      [
        { header: 'Repo' },
        { header: 'Events', align: 'right' },
        { header: 'Input', align: 'right' },
        { header: 'Output', align: 'right' },
        { header: 'CacheW', align: 'right' },
        { header: 'CacheR', align: 'right' },
        { header: 'Cost', align: 'right' },
      ],
      tableRows,
    ),
  );

  if (totals.unpriced_events > 0) {
    console.log();
    console.log(
      `* ${totals.unpriced_events} event(s) used a model with no price row — add it to prices.json to include in cost.`,
    );
  }

  store.close();
}
