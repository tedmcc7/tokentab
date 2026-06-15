import { Store } from '../../core/store/index.js';
import { priceEvent } from '../../core/pricing/index.js';
import type { CostCategory, LiteLLMPayload, PrCacheRow, PriceRow } from '../../core/types.js';
import { toLiteLLMPayload, type AttributionContext } from '../../core/export/litellm.js';
import { postPayload } from '../../core/export/sender.js';
import { startReceiver, type ReceiverRollup } from '../../core/export/receiver.js';
import { formatDollars, formatTokens, table } from '../format.js';

export type ExportCmdOptions = {
  to?: string;
  mock?: boolean;
  dryRun?: boolean;
  since?: string;
};

/** Parse a --since input as YYYY-MM-DD or ISO into an ISO instant. */
export function parseSince(input: string): string {
  // Accept a bare date (YYYY-MM-DD) as local midnight.
  if (/^\d{4}-\d{2}-\d{2}$/.test(input)) {
    return new Date(`${input}T00:00:00`).toISOString();
  }
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`invalid --since value "${input}" — use YYYY-MM-DD or an ISO 8601 timestamp`);
  }
  return d.toISOString();
}

function buildAttribution(
  event: { repo: string | null; git_branch: string | null },
  tab_name: string | null,
  cost_category: CostCategory,
  prCache: Map<string, PrCacheRow>,
): AttributionContext {
  let pr_number: number | null = null;
  if (event.repo && event.git_branch) {
    const c = prCache.get(`${event.repo}\x00${event.git_branch}`);
    if (c?.pr_number) pr_number = c.pr_number;
  }
  return { tab_name, cost_category, pr_number };
}

export async function runExport(opts: ExportCmdOptions): Promise<void> {
  // Flag validation. Refuse silly combinations rather than guessing intent.
  const targets = [opts.to ? 'to' : null, opts.mock ? 'mock' : null, opts.dryRun ? 'dry-run' : null].filter(
    Boolean,
  );
  if (targets.length === 0) {
    console.error('Provide --to <url>, --mock, or --dry-run.');
    process.exitCode = 1;
    return;
  }
  if (opts.to && opts.mock) {
    console.error('--to and --mock are mutually exclusive.');
    process.exitCode = 1;
    return;
  }
  if (opts.mock && opts.dryRun) {
    console.error('--mock and --dry-run are mutually exclusive (--mock receives + prints).');
    process.exitCode = 1;
    return;
  }

  let sinceIso: string;
  try {
    sinceIso = opts.since ? parseSince(opts.since) : '1970-01-01T00:00:00.000Z';
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 1;
    return;
  }

  const store = new Store();
  const prices: PriceRow[] = store.getPrices();
  const prCache = store.getPrCache();
  const events = store.eventsWithAttributionInRange(
    sinceIso,
    new Date(Date.now() + 86_400_000).toISOString(),
  );

  if (events.length === 0) {
    console.log('No events to export in range.');
    store.close();
    return;
  }

  const payloads: LiteLLMPayload[] = events.map((e) =>
    toLiteLLMPayload({
      event: {
        session_id: e.session_id,
        line_hash: e.line_hash,
        ts: e.ts,
        model: e.model,
        repo: e.repo,
        git_branch: e.git_branch,
        input_tokens: e.input_tokens,
        output_tokens: e.output_tokens,
        cache_write_tokens: e.cache_write_tokens,
        cache_read_tokens: e.cache_read_tokens,
      },
      pricing: priceEvent(e, prices),
      attribution: buildAttribution(e, e.tab_name, e.cost_category, prCache),
    }),
  );

  store.close();

  if (opts.dryRun && !opts.to) {
    // Standalone dry-run: dump payloads, one JSON per line.
    for (const p of payloads) console.log(JSON.stringify(p));
    console.error(`(dry-run: ${payloads.length} payload(s) NOT sent)`);
    return;
  }

  if (opts.mock) {
    const receiver = await startReceiver();
    console.log(`Mock receiver listening at ${receiver.url}`);
    try {
      const summary = await sendAll(receiver.url, payloads, false);
      console.log();
      console.log(`Sent ${summary.sent} payload(s); ${summary.deduped} deduped; ${summary.failed} failed.`);
      console.log();
      printReceiverRollup(receiver.rollup());
    } finally {
      await receiver.close();
    }
    return;
  }

  // Real --to URL (with or without --dry-run).
  if (!opts.to) {
    console.error('--to <url> is required unless --dry-run or --mock.');
    process.exitCode = 1;
    return;
  }
  const summary = await sendAll(opts.to, payloads, opts.dryRun === true);
  if (opts.dryRun) {
    console.error(`(dry-run: ${payloads.length} payload(s) NOT sent to ${opts.to})`);
  } else {
    console.log(
      `Sent ${summary.sent} payload(s) to ${opts.to}; ${summary.deduped} deduped; ${summary.failed} failed.`,
    );
  }
}

async function sendAll(
  url: string,
  payloads: LiteLLMPayload[],
  dryRun: boolean,
): Promise<{ sent: number; deduped: number; failed: number }> {
  if (dryRun) {
    for (const p of payloads) console.log(JSON.stringify(p));
    return { sent: 0, deduped: 0, failed: 0 };
  }
  let sent = 0;
  let deduped = 0;
  let failed = 0;
  for (const p of payloads) {
    const r = await postPayload(url, p);
    if (r.ok) {
      sent++;
      if (r.deduped) deduped++;
    } else {
      failed++;
      // Don't spam — first 3 failures get a line, then we go silent.
      if (failed <= 3) console.error(`failed to POST ${p.id}: ${r.error}`);
    }
  }
  return { sent, deduped, failed };
}

function printReceiverRollup(r: ReceiverRollup): void {
  console.log(
    `Receiver: ${r.unique_payloads} unique payload(s), ${r.total_deduped} deduped (${r.total_received} total received).`,
  );
  console.log();

  const renderRollup = (label: string, m: Map<string, { events: number; tokens: number; cost: number; unpriced: number }>): void => {
    if (m.size === 0) return;
    console.log(label);
    const rows = Array.from(m.entries())
      .sort(([, a], [, b]) => b.cost - a.cost)
      .map(([k, b]) => [
        k,
        String(b.events),
        formatTokens(b.tokens),
        b.unpriced > 0 ? `${formatDollars(b.cost)} *` : formatDollars(b.cost),
      ]);
    console.log(
      table(
        [
          { header: 'Key' },
          { header: 'Events', align: 'right' },
          { header: 'Tokens', align: 'right' },
          { header: 'Cost', align: 'right' },
        ],
        rows,
      ),
    );
    console.log();
  };

  renderRollup('By feature:', r.by_feature);
  renderRollup('By category:', r.by_category);

  const totalUnpriced = Array.from(r.by_category.values()).reduce((a, b) => a + b.unpriced, 0);
  if (totalUnpriced > 0) {
    console.log(`* ${totalUnpriced} event(s) sent as response_cost=null (unpriced models).`);
  }
}
