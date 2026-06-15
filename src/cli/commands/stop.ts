import { Store } from '../../core/store/index.js';
import { normalizeRepo } from '../../core/ingest/index.js';
import { priceEvent } from '../../core/pricing/index.js';
import { formatDollars, formatDuration, formatTokens } from '../format.js';

export function runStop(): void {
  const store = new Store();
  const repo = normalizeRepo(process.cwd());
  const open = store.getOpenTab(repo);
  if (!open) {
    const where = repo === null ? '(no repo detected)' : `repo "${repo}"`;
    console.log(`No open tab in ${where}.`);
    store.close();
    return;
  }
  const stopped = store.stopTab(open.id);
  // Reload rollup so we can price what this tab actually cost.
  const tabs = store.listTabsWithRollups(200);
  const rollup = tabs.find((t) => t.tab.id === stopped.id);
  const prices = store.getPrices();

  // For pricing the tab, we need per-event model granularity; the rollup
  // lacks that. Re-query events covered by the tab and price each one.
  const events = store.eventsInRange(stopped.started_at, stopped.ended_at ?? new Date(Date.now() + 1000).toISOString())
    .filter((e) => (e.repo ?? null) === (stopped.repo ?? null));
  let cost = 0;
  let unpriced = 0;
  for (const e of events) {
    const p = priceEvent(e, prices);
    if (p.priced) cost += p.cost;
    else unpriced++;
  }

  const duration = formatDuration(stopped.started_at, stopped.ended_at!);
  console.log(`Stopped tab "${stopped.name}" (${duration}).`);
  if (rollup) {
    const totalTokens =
      rollup.input_tokens + rollup.output_tokens + rollup.cache_write_tokens + rollup.cache_read_tokens;
    console.log(
      `  ${rollup.events} event(s), ${formatTokens(totalTokens)} token(s), ${
        unpriced > 0 ? `${formatDollars(cost)} (${unpriced} unpriced)` : formatDollars(cost)
      }.`,
    );
  }
  store.close();
}
