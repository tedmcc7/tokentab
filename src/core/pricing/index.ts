import type { PriceRow, PricingResult, TokenCounts } from '../types.js';

/**
 * Find the price row that applies to `(model, date)`.
 *
 * Selects the row with the latest `effective_date <= date` for the given model.
 * Returns `null` if no row matches.
 */
export function findPrice(prices: PriceRow[], model: string, date: string): PriceRow | null {
  let best: PriceRow | null = null;
  for (const p of prices) {
    if (p.model !== model) continue;
    if (p.effective_date > date) continue;
    if (best === null || p.effective_date > best.effective_date) best = p;
  }
  return best;
}

/**
 * Cost of `tokens` priced by `price`. Each of the four token classes is priced
 * independently — summing raw tokens is a bug.
 */
export function calculateCost(tokens: TokenCounts, price: PriceRow): number {
  return (
    (tokens.input_tokens / 1_000_000) * price.input_per_mtok +
    (tokens.output_tokens / 1_000_000) * price.output_per_mtok +
    (tokens.cache_write_tokens / 1_000_000) * price.cache_write_per_mtok +
    (tokens.cache_read_tokens / 1_000_000) * price.cache_read_per_mtok
  );
}

/**
 * Price one event. Returns `{priced:false}` if no applicable price row exists.
 * The CLI shows unpriced events as `—`, never as `$0` — silently charging zero
 * for an unknown model is the bug TokenTab exists to prevent.
 */
export function priceEvent(
  event: TokenCounts & { model: string; ts: string },
  prices: PriceRow[],
): PricingResult {
  const date = event.ts.slice(0, 10);
  const price = findPrice(prices, event.model, date);
  if (!price) {
    const hasModel = prices.some((p) => p.model === event.model);
    return {
      priced: false,
      reason: hasModel ? 'no_applicable_date' : 'unpriced_model',
    };
  }
  return {
    priced: true,
    cost: calculateCost(event, price),
    effective_date: price.effective_date,
  };
}
