import { Store } from '../../core/store/index.js';
import { priceEvent } from '../../core/pricing/index.js';
import type { EventRow } from '../../core/store/index.js';
import type { PrCacheRow, PriceRow } from '../../core/types.js';
import { defaultGhRunner, resolvePrs, prKey } from '../../core/pr/gh.js';
import { formatDollars, formatTokens, table } from '../format.js';

const WINDOW_DAYS = 30;
const PR_CACHE_TTL_MS = 60 * 60 * 1000;

export type ReportBy = 'tab' | 'branch' | 'day' | 'pr' | 'category';

type Bucket = {
  events: number;
  input: number;
  output: number;
  cache_write: number;
  cache_read: number;
  cost: number;
  unpriced: number;
  sample_cwd: string | null;
};

function emptyBucket(): Bucket {
  return {
    events: 0,
    input: 0,
    output: 0,
    cache_write: 0,
    cache_read: 0,
    cost: 0,
    unpriced: 0,
    sample_cwd: null,
  };
}

function add(b: Bucket, e: EventRow, prices: PriceRow[]): void {
  b.events++;
  b.input += e.input_tokens;
  b.output += e.output_tokens;
  b.cache_write += e.cache_write_tokens;
  b.cache_read += e.cache_read_tokens;
  if (b.sample_cwd === null && e.cwd !== null) b.sample_cwd = e.cwd;
  const p = priceEvent(e, prices);
  if (p.priced) b.cost += p.cost;
  else b.unpriced++;
}

function fmtCost(b: Bucket): string {
  if (b.unpriced === b.events) return '—';
  return b.unpriced > 0 ? `${formatDollars(b.cost)} *` : formatDollars(b.cost);
}

function fmtTokens(b: Bucket): string {
  return formatTokens(b.input + b.output + b.cache_write + b.cache_read);
}

function windowFromIso(): string {
  return new Date(Date.now() - WINDOW_DAYS * 86_400_000).toISOString();
}

function unpricedFootnote(total: number): string {
  return `* ${total} event(s) used a model with no price row — add it to prices.json to include in cost.`;
}

export async function runReport(by: ReportBy): Promise<void> {
  const store = new Store();
  const prices = store.getPrices();
  switch (by) {
    case 'tab':
      reportByTab(store, prices);
      break;
    case 'branch':
      reportByBranch(store, prices);
      break;
    case 'day':
      reportByDay(store, prices);
      break;
    case 'pr':
      await reportByPr(store, prices);
      break;
    case 'category':
      reportByCategory(store, prices);
      break;
  }
  store.close();
}

function reportByCategory(store: Store, prices: PriceRow[]): void {
  const fromIso = windowFromIso();
  const events = store.eventsWithAttributionInRange(
    fromIso,
    new Date(Date.now() + 86_400_000).toISOString(),
  );
  if (events.length === 0) {
    console.log('No events in the last 30 days.');
    return;
  }
  const buckets = new Map<string, Bucket>();
  for (const e of events) {
    let b = buckets.get(e.cost_category);
    if (!b) {
      b = emptyBucket();
      buckets.set(e.cost_category, b);
    }
    add(b, e, prices);
  }
  // Stable display order: COGS, OpEx, unclassified.
  const order = ['COGS', 'OpEx', 'unclassified'];
  const rows = order
    .map((cat) => [cat, buckets.get(cat)] as const)
    .filter((r): r is readonly [string, Bucket] => r[1] !== undefined)
    .map(([cat, b]) => [cat, String(b.events), fmtTokens(b), fmtCost(b)]);
  console.log(`By cost category (last ${WINDOW_DAYS} days)`);
  console.log();
  console.log(
    table(
      [
        { header: 'Category' },
        { header: 'Events', align: 'right' },
        { header: 'Tokens', align: 'right' },
        { header: 'Cost', align: 'right' },
      ],
      rows,
    ),
  );
  const totalUnpriced = Array.from(buckets.values()).reduce((a, b) => a + b.unpriced, 0);
  if (totalUnpriced > 0) {
    console.log();
    console.log(unpricedFootnote(totalUnpriced));
  }
}

function reportByTab(store: Store, prices: PriceRow[]): void {
  const fromIso = windowFromIso();
  const rollups = store.listTabsWithRollups(200);

  if (rollups.length === 0) {
    console.log('No tabs defined yet. Run `tt start <name>` to open one.');
    // Still useful to show untagged-by-branch so the user sees their spend.
  }

  type Row = { tab: typeof rollups[number]['tab']; bucket: Bucket };
  const tabRows: Row[] = rollups.map((r) => {
    const bucket = emptyBucket();
    const upper = r.tab.ended_at ?? new Date(Date.now() + 86_400_000).toISOString();
    const events = store
      .eventsInRange(r.tab.started_at, upper)
      .filter((e) => (e.repo ?? null) === (r.tab.repo ?? null));
    for (const e of events) add(bucket, e, prices);
    return { tab: r.tab, bucket };
  });

  let totalUnpriced = 0;

  if (tabRows.length > 0) {
    const tableData = tabRows.map((r) => [
      r.tab.name,
      r.tab.repo ?? '—',
      r.tab.ended_at === null ? 'open' : 'closed',
      String(r.bucket.events),
      fmtTokens(r.bucket),
      fmtCost(r.bucket),
    ]);
    console.log('Tabs');
    console.log();
    console.log(
      table(
        [
          { header: 'Tab' },
          { header: 'Repo' },
          { header: 'Status' },
          { header: 'Events', align: 'right' },
          { header: 'Tokens', align: 'right' },
          { header: 'Cost', align: 'right' },
        ],
        tableData,
      ),
    );
    totalUnpriced += tabRows.reduce((a, r) => a + r.bucket.unpriced, 0);
  }

  const untaggedEvents = store.untaggedEventsInRange(
    fromIso,
    new Date(Date.now() + 86_400_000).toISOString(),
  );
  if (untaggedEvents.length > 0) {
    console.log();
    console.log(`Untagged events (last ${WINDOW_DAYS} days, by branch)`);
    console.log();
    const branchBuckets = new Map<string, Bucket & { repo: string | null; branch: string | null }>();
    for (const e of untaggedEvents) {
      const key = `${e.repo ?? ''}\x00${e.git_branch ?? ''}`;
      let b = branchBuckets.get(key);
      if (!b) {
        b = { ...emptyBucket(), repo: e.repo, branch: e.git_branch };
        branchBuckets.set(key, b);
      }
      add(b, e, prices);
    }
    const rows = Array.from(branchBuckets.values())
      .sort((a, b) => b.cost - a.cost)
      .map((b) => [
        b.repo ?? '—',
        b.branch ?? '—',
        String(b.events),
        fmtTokens(b),
        fmtCost(b),
      ]);
    console.log(
      table(
        [
          { header: 'Repo' },
          { header: 'Branch' },
          { header: 'Events', align: 'right' },
          { header: 'Tokens', align: 'right' },
          { header: 'Cost', align: 'right' },
        ],
        rows,
      ),
    );
    totalUnpriced += Array.from(branchBuckets.values()).reduce((a, b) => a + b.unpriced, 0);
  }

  if (totalUnpriced > 0) {
    console.log();
    console.log(unpricedFootnote(totalUnpriced));
  }
}

function reportByBranch(store: Store, prices: PriceRow[]): void {
  const fromIso = windowFromIso();
  const events = store.eventsInRange(fromIso, new Date(Date.now() + 86_400_000).toISOString());
  if (events.length === 0) {
    console.log('No events in the last 30 days.');
    return;
  }
  const buckets = new Map<string, Bucket & { repo: string | null; branch: string | null }>();
  for (const e of events) {
    const key = `${e.repo ?? ''}\x00${e.git_branch ?? ''}`;
    let b = buckets.get(key);
    if (!b) {
      b = { ...emptyBucket(), repo: e.repo, branch: e.git_branch };
      buckets.set(key, b);
    }
    add(b, e, prices);
  }
  const rows = Array.from(buckets.values())
    .sort((a, b) => b.cost - a.cost)
    .map((b) => [
      b.repo ?? '—',
      b.branch ?? '—',
      String(b.events),
      fmtTokens(b),
      fmtCost(b),
    ]);
  console.log(`By branch (last ${WINDOW_DAYS} days)`);
  console.log();
  console.log(
    table(
      [
        { header: 'Repo' },
        { header: 'Branch' },
        { header: 'Events', align: 'right' },
        { header: 'Tokens', align: 'right' },
        { header: 'Cost', align: 'right' },
      ],
      rows,
    ),
  );
  const totalUnpriced = Array.from(buckets.values()).reduce((a, b) => a + b.unpriced, 0);
  if (totalUnpriced > 0) {
    console.log();
    console.log(unpricedFootnote(totalUnpriced));
  }
}

function reportByDay(store: Store, prices: PriceRow[]): void {
  const fromIso = new Date(Date.now() - 14 * 86_400_000).toISOString();
  const events = store.eventsInRange(fromIso, new Date(Date.now() + 86_400_000).toISOString());
  if (events.length === 0) {
    console.log('No events in the last 14 days.');
    return;
  }
  const buckets = new Map<string, Bucket>();
  for (const e of events) {
    const day = e.ts.slice(0, 10);
    let b = buckets.get(day);
    if (!b) {
      b = emptyBucket();
      buckets.set(day, b);
    }
    add(b, e, prices);
  }
  const rows = Array.from(buckets.entries())
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .map(([day, b]) => [day, String(b.events), fmtTokens(b), fmtCost(b)]);
  console.log(`By day (last 14 days)`);
  console.log();
  console.log(
    table(
      [
        { header: 'Date' },
        { header: 'Events', align: 'right' },
        { header: 'Tokens', align: 'right' },
        { header: 'Cost', align: 'right' },
      ],
      rows,
    ),
  );
  const totalUnpriced = Array.from(buckets.values()).reduce((a, b) => a + b.unpriced, 0);
  if (totalUnpriced > 0) {
    console.log();
    console.log(unpricedFootnote(totalUnpriced));
  }
}

async function reportByPr(store: Store, prices: PriceRow[]): Promise<void> {
  const fromIso = windowFromIso();
  const events = store.eventsInRange(fromIso, new Date(Date.now() + 86_400_000).toISOString());
  if (events.length === 0) {
    console.log('No events in the last 30 days.');
    return;
  }

  // Bucket by (repo, branch); skip events missing either.
  const buckets = new Map<string, Bucket & { repo: string; branch: string }>();
  const unaddressable: Bucket = emptyBucket();
  for (const e of events) {
    if (!e.repo || !e.git_branch || e.git_branch === 'HEAD') {
      add(unaddressable, e, prices);
      continue;
    }
    const key = `${e.repo}\x00${e.git_branch}`;
    let b = buckets.get(key);
    if (!b) {
      b = { ...emptyBucket(), repo: e.repo, branch: e.git_branch };
      buckets.set(key, b);
    }
    add(b, e, prices);
  }

  // Determine which (repo, branch) need a PR lookup (no cache or stale).
  const cache = store.getPrCache();
  const stale = (c: PrCacheRow): boolean =>
    Date.now() - new Date(c.fetched_at).getTime() > PR_CACHE_TTL_MS;
  const needLookup = Array.from(buckets.values())
    .filter((b) => {
      const c = cache.get(`${b.repo}\x00${b.branch}`);
      return !c || stale(c);
    })
    .map((b) => ({ repo: b.repo, branch: b.branch, sample_cwd: b.sample_cwd }));

  let ghHint: string | null = null;
  if (needLookup.length > 0) {
    const result = resolvePrs(needLookup, defaultGhRunner());
    if (result.ok) {
      for (const [k, pr] of result.prs) {
        const [repo, branch] = k.split('\x00');
        store.upsertPrCache(repo, branch, pr);
      }
    } else {
      // Persist whatever partial results we got so successive runs make progress.
      for (const [k, pr] of result.partial) {
        const [repo, branch] = k.split('\x00');
        store.upsertPrCache(repo, branch, pr);
      }
      ghHint =
        result.reason === 'gh_missing'
          ? '`gh` CLI not found. Install GitHub CLI for PR rollup. Falling back to branch view.'
          : '`gh` failed (often: not authenticated — try `gh auth login`). Falling back to branch view.';
    }
  }

  if (ghHint) {
    console.log(ghHint);
    console.log();
    reportByBranch(store, prices);
    return;
  }

  const updatedCache = store.getPrCache();
  type Row = {
    pr_label: string;
    title: string;
    repo: string;
    branch: string;
    bucket: Bucket;
  };
  const rows: Row[] = Array.from(buckets.values()).map((b) => {
    const c = updatedCache.get(prKey(b.repo, b.branch));
    return {
      pr_label: c?.pr_number ? `#${c.pr_number}` : '—',
      title: c?.pr_title ?? '(no PR)',
      repo: b.repo,
      branch: b.branch,
      bucket: b,
    };
  });
  rows.sort((a, b) => b.bucket.cost - a.bucket.cost);

  const tableData = rows.map((r) => [
    r.pr_label,
    truncate(r.title, 40),
    r.repo,
    r.branch,
    String(r.bucket.events),
    fmtTokens(r.bucket),
    fmtCost(r.bucket),
  ]);
  console.log(`By PR (last ${WINDOW_DAYS} days)`);
  console.log();
  console.log(
    table(
      [
        { header: 'PR', align: 'right' },
        { header: 'Title' },
        { header: 'Repo' },
        { header: 'Branch' },
        { header: 'Events', align: 'right' },
        { header: 'Tokens', align: 'right' },
        { header: 'Cost', align: 'right' },
      ],
      tableData,
    ),
  );
  if (unaddressable.events > 0) {
    console.log();
    console.log(
      `${unaddressable.events} event(s) had no branch info and could not be mapped to a PR — ${fmtTokens(unaddressable)} token(s), ${fmtCost(unaddressable)}.`,
    );
  }
  const totalUnpriced =
    rows.reduce((a, r) => a + r.bucket.unpriced, 0) + unaddressable.unpriced;
  if (totalUnpriced > 0) {
    console.log();
    console.log(unpricedFootnote(totalUnpriced));
  }
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + '…';
}
