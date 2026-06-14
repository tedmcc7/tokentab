import { describe, it, expect } from 'vitest';
import { findPrice, calculateCost, priceEvent } from '../src/core/pricing/index.js';
import type { PriceRow } from '../src/core/types.js';

const opusJan: PriceRow = {
  model: 'claude-opus-4-7',
  effective_date: '2025-01-01',
  input_per_mtok: 15,
  output_per_mtok: 75,
  cache_write_per_mtok: 18.75,
  cache_read_per_mtok: 1.5,
};

const opusJul: PriceRow = {
  model: 'claude-opus-4-7',
  effective_date: '2025-07-01',
  input_per_mtok: 12,
  output_per_mtok: 60,
  cache_write_per_mtok: 15,
  cache_read_per_mtok: 1.2,
};

const sonnet: PriceRow = {
  model: 'claude-sonnet-4-6',
  effective_date: '2025-01-01',
  input_per_mtok: 3,
  output_per_mtok: 15,
  cache_write_per_mtok: 3.75,
  cache_read_per_mtok: 0.3,
};

const PRICES = [opusJan, opusJul, sonnet];

describe('findPrice — date selection', () => {
  it('returns the latest row with effective_date <= event date', () => {
    expect(findPrice(PRICES, 'claude-opus-4-7', '2025-06-30')).toBe(opusJan);
    expect(findPrice(PRICES, 'claude-opus-4-7', '2025-07-01')).toBe(opusJul);
    expect(findPrice(PRICES, 'claude-opus-4-7', '2025-12-31')).toBe(opusJul);
  });

  it('returns null when the event date is before any effective_date', () => {
    expect(findPrice(PRICES, 'claude-opus-4-7', '2024-12-31')).toBeNull();
  });

  it('returns null for an unknown model', () => {
    expect(findPrice(PRICES, 'claude-unknown-9-9', '2025-06-01')).toBeNull();
  });

  it('does not cross models when picking by date', () => {
    expect(findPrice(PRICES, 'claude-sonnet-4-6', '2025-12-31')).toBe(sonnet);
  });
});

describe('calculateCost — each token class priced independently', () => {
  it('sums per-class contributions correctly', () => {
    const tokens = {
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
      cache_write_tokens: 1_000_000,
      cache_read_tokens: 1_000_000,
    };
    // 15 + 75 + 18.75 + 1.5 = 110.25
    expect(calculateCost(tokens, opusJan)).toBeCloseTo(110.25, 10);
  });

  it('prices only the classes that have tokens (others contribute zero)', () => {
    expect(
      calculateCost(
        {
          input_tokens: 1_000_000,
          output_tokens: 0,
          cache_write_tokens: 0,
          cache_read_tokens: 0,
        },
        opusJan,
      ),
    ).toBeCloseTo(15, 10);

    expect(
      calculateCost(
        {
          input_tokens: 0,
          output_tokens: 0,
          cache_write_tokens: 0,
          cache_read_tokens: 1_000_000,
        },
        opusJan,
      ),
    ).toBeCloseTo(1.5, 10);
  });

  it('cache-heavy session: cache_read dominates and is priced cheap, not as input', () => {
    const tokens = {
      input_tokens: 3,
      output_tokens: 98,
      cache_write_tokens: 4_822,
      cache_read_tokens: 2_500_000,
    };
    // input:    3       / 1e6 * 15    = 0.000045
    // output:   98      / 1e6 * 75    = 0.00735
    // write:    4822    / 1e6 * 18.75 = 0.09041250
    // read:     2500000 / 1e6 * 1.5   = 3.75
    const expected = 0.000045 + 0.00735 + 0.0904125 + 3.75;
    expect(calculateCost(tokens, opusJan)).toBeCloseTo(expected, 8);

    // Sanity: pricing the same tokens as if they were all input would be ~37x more.
    // That is the bug naive trackers ship; the test pins that we do not.
    const naiveAllInput = ((3 + 98 + 4_822 + 2_500_000) / 1_000_000) * 15;
    expect(naiveAllInput / expected).toBeGreaterThan(5);
  });
});

describe('priceEvent — fallbacks', () => {
  const baseEvent = {
    input_tokens: 100,
    output_tokens: 50,
    cache_write_tokens: 0,
    cache_read_tokens: 0,
  };

  it('flags unknown models as unpriced — never charges $0', () => {
    const r = priceEvent(
      { ...baseEvent, model: 'claude-mystery-9', ts: '2025-06-01T00:00:00Z' },
      PRICES,
    );
    expect(r).toEqual({ priced: false, reason: 'unpriced_model' });
  });

  it('distinguishes unpriced_model from no_applicable_date', () => {
    const r = priceEvent(
      { ...baseEvent, model: 'claude-opus-4-7', ts: '2024-06-01T00:00:00Z' },
      PRICES,
    );
    expect(r).toEqual({ priced: false, reason: 'no_applicable_date' });
  });

  it('prices a normal event with the correct effective_date', () => {
    const r = priceEvent(
      { ...baseEvent, model: 'claude-opus-4-7', ts: '2025-08-15T00:00:00Z' },
      PRICES,
    );
    expect(r.priced).toBe(true);
    if (r.priced) {
      expect(r.effective_date).toBe('2025-07-01');
      // 100/1e6 * 12 + 50/1e6 * 60 = 0.0012 + 0.003 = 0.0042
      expect(r.cost).toBeCloseTo(0.0042, 10);
    }
  });
});
