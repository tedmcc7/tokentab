import { Store } from '../../core/store/index.js';
import { priceEvent } from '../../core/pricing/index.js';
import type { PriceRow } from '../../core/types.js';
import { formatDollars, formatTokens, table } from '../format.js';

const DAYS = 14;

export function runLs(): void {
  const store = new Store();
  const prices: PriceRow[] = store.getPrices();

  // Pull all events from the last DAYS days and price client-side. We avoid
  // SQL-side cost rollups because pricing logic (date selection, unpriced
  // fallback) lives in one place — the pricing module — and is unit-tested.
  const now = new Date();
  const from = new Date(now.getTime() - DAYS * 24 * 60 * 60 * 1000);
  const events = store.eventsInRange(from.toISOString(), new Date(now.getTime() + 86_400_000).toISOString());

  if (events.length === 0) {
    console.log('No events recorded yet.');
    console.log('Run `tt ingest` to scan your local Claude Code logs.');
    store.close();
    return;
  }

  type Day = {
    date: string;
    events: number;
    input: number;
    output: number;
    cache_write: number;
    cache_read: number;
    cost: number;
    unpriced_events: number;
  };
  const byDay = new Map<string, Day>();

  for (const e of events) {
    const date = e.ts.slice(0, 10);
    let d = byDay.get(date);
    if (!d) {
      d = {
        date,
        events: 0,
        input: 0,
        output: 0,
        cache_write: 0,
        cache_read: 0,
        cost: 0,
        unpriced_events: 0,
      };
      byDay.set(date, d);
    }
    d.events++;
    d.input += e.input_tokens;
    d.output += e.output_tokens;
    d.cache_write += e.cache_write_tokens;
    d.cache_read += e.cache_read_tokens;
    const p = priceEvent(e, prices);
    if (p.priced) d.cost += p.cost;
    else d.unpriced_events++;
  }

  const rows = Array.from(byDay.values()).sort((a, b) => (a.date < b.date ? 1 : -1));

  const tableRows = rows.map((d) => [
    d.date,
    String(d.events),
    formatTokens(d.input),
    formatTokens(d.output),
    formatTokens(d.cache_write),
    formatTokens(d.cache_read),
    d.unpriced_events === d.events
      ? '—'
      : d.unpriced_events > 0
        ? `${formatDollars(d.cost)} *`
        : formatDollars(d.cost),
  ]);

  console.log(`Last ${DAYS} day(s) — one row per UTC day`);
  console.log();
  console.log(
    table(
      [
        { header: 'Date' },
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

  const totalUnpriced = rows.reduce((a, d) => a + d.unpriced_events, 0);
  if (totalUnpriced > 0) {
    console.log();
    console.log(
      `* ${totalUnpriced} event(s) used a model with no price row — add it to prices.json to include in cost.`,
    );
  }

  store.close();
}
