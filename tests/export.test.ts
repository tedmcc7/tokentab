import { describe, it, expect, afterEach } from 'vitest';
import { toLiteLLMPayload, assertNoContent } from '../src/core/export/litellm.js';
import { priceEvent } from '../src/core/pricing/index.js';
import { startReceiver, type Receiver } from '../src/core/export/receiver.js';
import { postPayload } from '../src/core/export/sender.js';
import { FIXTURE_EVENTS, FIXTURE_PRICES } from './fixtures/events.js';

describe('toLiteLLMPayload — mapping correctness', () => {
  it('maps a normal event with feature + category + PR metadata', () => {
    const event = FIXTURE_EVENTS[0];
    const pricing = priceEvent(event, FIXTURE_PRICES);
    const payload = toLiteLLMPayload({
      event,
      pricing,
      attribution: { tab_name: 'checkout-redesign', cost_category: 'COGS', pr_number: 42 },
    });

    expect(payload.id).toBe('sess-normal:hash-normal');
    expect(payload.call_type).toBe('completion');
    expect(payload.model).toBe('claude-opus-4-7');
    expect(payload.custom_llm_provider).toBe('anthropic');
    expect(payload.cache_hit).toBe(false);
    // startTime / endTime are epoch seconds (matches ramp_export_proof.mjs).
    expect(payload.startTime).toBe(Math.floor(new Date(event.ts).getTime() / 1000));
    expect(payload.endTime).toBe(payload.startTime);

    expect(payload.prompt_tokens).toBe(100);
    expect(payload.completion_tokens).toBe(50);
    expect(payload.total_tokens).toBe(150);
    expect(payload.cache_creation_input_tokens).toBe(0);
    expect(payload.cache_read_input_tokens).toBe(0);

    // 100/1e6 * 15 + 50/1e6 * 75 = 0.0015 + 0.00375 = 0.00525
    expect(payload.response_cost).toBeCloseTo(0.00525, 10);

    expect(payload.metadata.requester_metadata).toEqual({
      feature: 'checkout-redesign',
      repo: 'repo-a',
      git_branch: 'main',
      pr: 42,
      cost_category: 'COGS',
    });
  });

  it('preserves all four token classes faithfully on a cache-heavy event', () => {
    const event = FIXTURE_EVENTS[1];
    const pricing = priceEvent(event, FIXTURE_PRICES);
    const payload = toLiteLLMPayload({
      event,
      pricing,
      attribution: { tab_name: null, cost_category: 'unclassified', pr_number: null },
    });

    expect(payload.cache_hit).toBe(true);
    // Original four classes preserved verbatim so downstream consumers can
    // recompute cost without re-deriving:
    expect(payload.cache_creation_input_tokens).toBe(4_822);
    expect(payload.cache_read_input_tokens).toBe(2_500_000);
    // LiteLLM convention: prompt_tokens sums every input-side class.
    expect(payload.prompt_tokens).toBe(3 + 4_822 + 2_500_000);
    expect(payload.completion_tokens).toBe(98);
    expect(payload.total_tokens).toBe(3 + 4_822 + 2_500_000 + 98);

    // Pricing pins the per-class engine end-to-end:
    // 3/1e6*3 + 98/1e6*15 + 4822/1e6*3.75 + 2500000/1e6*0.3 ≈ 0.769578
    expect(payload.response_cost).toBeCloseTo(
      (3 / 1e6) * 3 + (98 / 1e6) * 15 + (4822 / 1e6) * 3.75 + (2_500_000 / 1e6) * 0.3,
      8,
    );
  });

  it('sets response_cost to null (NOT 0) for an unpriced model', () => {
    const event = FIXTURE_EVENTS[2];
    const pricing = priceEvent(event, FIXTURE_PRICES);
    expect(pricing.priced).toBe(false); // sanity: fixture is genuinely unpriced
    const payload = toLiteLLMPayload({
      event,
      pricing,
      attribution: { tab_name: null, cost_category: 'unclassified', pr_number: null },
    });
    expect(payload.response_cost).toBeNull();
    // Explicit anti-test: must NOT be 0 (that's the bug TokenTab exists to prevent).
    expect(payload.response_cost as number | null).not.toBe(0);
  });

  it('maps cost_category through unchanged for COGS / OpEx / unclassified', () => {
    const event = FIXTURE_EVENTS[0];
    const pricing = priceEvent(event, FIXTURE_PRICES);
    for (const cat of ['COGS', 'OpEx', 'unclassified'] as const) {
      const p = toLiteLLMPayload({
        event,
        pricing,
        attribution: { tab_name: 'x', cost_category: cat, pr_number: null },
      });
      expect(p.metadata.requester_metadata.cost_category).toBe(cat);
    }
  });
});

describe('PRIVACY: no "content" key', () => {
  it('produced payloads never contain a "content" key anywhere', () => {
    for (const event of FIXTURE_EVENTS) {
      const payload = toLiteLLMPayload({
        event,
        pricing: priceEvent(event, FIXTURE_PRICES),
        attribution: { tab_name: 'x', cost_category: 'COGS', pr_number: 1 },
      });
      // Belt: JSON.stringify scan.
      expect(JSON.stringify(payload)).not.toMatch(/"content"/);
      // Suspenders: structural recursion.
      expect(() => assertNoContent(payload)).not.toThrow();
    }
  });

  it('assertNoContent throws when handed a payload that smuggles content', () => {
    expect(() =>
      assertNoContent({
        id: 'x',
        usage: { prompt_tokens: 1 },
        metadata: { requester_metadata: { content: 'SECRET' } },
      }),
    ).toThrow(/forbidden "content"/);
  });

  it('assertNoContent catches content nested inside arrays', () => {
    expect(() =>
      assertNoContent({
        messages: [{ role: 'user', content: 'SECRET' }],
      }),
    ).toThrow(/forbidden "content"/);
  });
});

describe('export — receiver dedupes by id (idempotent re-export)', () => {
  let receiver: Receiver | null = null;
  afterEach(async () => {
    if (receiver) await receiver.close();
    receiver = null;
  });

  it('posting the same payload twice keeps a single unique row', async () => {
    receiver = await startReceiver();
    const event = FIXTURE_EVENTS[0];
    const payload = toLiteLLMPayload({
      event,
      pricing: priceEvent(event, FIXTURE_PRICES),
      attribution: { tab_name: 'x', cost_category: 'COGS', pr_number: null },
    });
    const first = await postPayload(receiver.url, payload);
    const second = await postPayload(receiver.url, payload);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (first.ok) expect(first.deduped).toBe(false);
    if (second.ok) expect(second.deduped).toBe(true);
    expect(receiver.payloads()).toHaveLength(1);
    const rollup = receiver.rollup();
    expect(rollup.total_received).toBe(2);
    expect(rollup.total_deduped).toBe(1);
    expect(rollup.unique_payloads).toBe(1);
  });

  it('posting the whole fixture batch twice still yields one row per event', async () => {
    receiver = await startReceiver();
    const payloads = FIXTURE_EVENTS.map((event) =>
      toLiteLLMPayload({
        event,
        pricing: priceEvent(event, FIXTURE_PRICES),
        attribution: { tab_name: null, cost_category: 'unclassified', pr_number: null },
      }),
    );
    for (const p of payloads) await postPayload(receiver.url, p);
    for (const p of payloads) await postPayload(receiver.url, p); // re-export
    expect(receiver.payloads()).toHaveLength(FIXTURE_EVENTS.length);
    const rollup = receiver.rollup();
    expect(rollup.unique_payloads).toBe(FIXTURE_EVENTS.length);
    // The unpriced event should land in by_category as 1 unpriced count, not as $0.
    const unclassified = rollup.by_category.get('unclassified');
    expect(unclassified?.events).toBe(FIXTURE_EVENTS.length);
    expect(unclassified?.unpriced).toBe(1);
  });

  it('receiver rejects payloads without an id (400)', async () => {
    receiver = await startReceiver();
    const res = await fetch(receiver.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ no_id_here: true }),
    });
    expect(res.status).toBe(400);
  });
});

describe('export — cost_category propagation through rollup', () => {
  let receiver: Receiver | null = null;
  afterEach(async () => {
    if (receiver) await receiver.close();
    receiver = null;
  });

  it('by_category buckets cleanly split COGS vs OpEx vs unclassified', async () => {
    receiver = await startReceiver();
    const cases = [
      { ev: FIXTURE_EVENTS[0], cat: 'COGS' as const },
      { ev: FIXTURE_EVENTS[1], cat: 'OpEx' as const },
      { ev: FIXTURE_EVENTS[2], cat: 'unclassified' as const },
    ];
    for (const { ev, cat } of cases) {
      const payload = toLiteLLMPayload({
        event: ev,
        pricing: priceEvent(ev, FIXTURE_PRICES),
        attribution: { tab_name: cat === 'unclassified' ? null : cat, cost_category: cat, pr_number: null },
      });
      await postPayload(receiver.url, payload);
    }
    const rollup = receiver.rollup();
    expect(rollup.by_category.get('COGS')?.events).toBe(1);
    expect(rollup.by_category.get('OpEx')?.events).toBe(1);
    expect(rollup.by_category.get('unclassified')?.events).toBe(1);
    // Unpriced event tracked as unpriced, not as $0.
    expect(rollup.by_category.get('unclassified')?.unpriced).toBe(1);
    expect(rollup.by_category.get('unclassified')?.cost).toBe(0);
  });
});
