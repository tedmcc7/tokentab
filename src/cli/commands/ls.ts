import { Store } from '../../core/store/index.js';
import { priceEvent } from '../../core/pricing/index.js';
import type { PriceRow } from '../../core/types.js';
import { formatDollars, formatDuration, formatTokens, table } from '../format.js';

const LIMIT = 20;

export function runLs(): void {
  const store = new Store();
  const rollups = store.listTabsWithRollups(LIMIT);
  if (rollups.length === 0) {
    console.log('No tabs yet. Run `tt start <name>` to open one.');
    store.close();
    return;
  }

  const prices: PriceRow[] = store.getPrices();

  const rows = rollups.map((r) => {
    // Price each tab's events individually so per-event model granularity is preserved.
    const upper = r.tab.ended_at ?? new Date(Date.now() + 86_400_000).toISOString();
    const events = store
      .eventsInRange(r.tab.started_at, upper)
      .filter((e) => (e.repo ?? null) === (r.tab.repo ?? null));
    let cost = 0;
    let unpriced = 0;
    for (const e of events) {
      const p = priceEvent(e, prices);
      if (p.priced) cost += p.cost;
      else unpriced++;
    }
    const tokens =
      r.input_tokens + r.output_tokens + r.cache_write_tokens + r.cache_read_tokens;
    const status = r.tab.ended_at === null ? 'open' : 'closed';
    return [
      r.tab.name,
      r.tab.repo ?? '—',
      status,
      formatDuration(r.tab.started_at, r.tab.ended_at),
      String(r.events),
      formatTokens(tokens),
      unpriced > 0 ? `${formatDollars(cost)} *` : formatDollars(cost),
    ];
  });

  console.log(`Recent tabs (${rollups.length})`);
  console.log();
  console.log(
    table(
      [
        { header: 'Tab' },
        { header: 'Repo' },
        { header: 'Status' },
        { header: 'Duration', align: 'right' },
        { header: 'Events', align: 'right' },
        { header: 'Tokens', align: 'right' },
        { header: 'Cost', align: 'right' },
      ],
      rows,
    ),
  );

  store.close();
}
