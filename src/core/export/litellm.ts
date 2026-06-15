import type {
  CostCategory,
  LiteLLMPayload,
  PricingResult,
  TokenCounts,
} from '../types.js';

export type ExportableEvent = TokenCounts & {
  session_id: string;
  line_hash: string;
  ts: string;
  model: string;
  repo: string | null;
  git_branch: string | null;
};

export type AttributionContext = {
  tab_name: string | null;
  cost_category: CostCategory;
  pr_number: number | null;
};

export type LiteLLMInput = {
  event: ExportableEvent;
  pricing: PricingResult;
  attribution: AttributionContext;
};

/**
 * Map one event into a faithful subset of LiteLLM's Standard Logging Payload.
 * Shape matches `examples/ramp_export_proof.mjs` — flat token fields at top
 * level, epoch-seconds timestamps.
 *
 * Faithfulness rules — these are tested invariants, not preferences:
 *
 * 1. The four token classes survive end-to-end. `prompt_tokens` is the sum of
 *    all input-side classes (input + cache_write + cache_read), so a downstream
 *    consumer sees the same total prompt volume LiteLLM would emit. The
 *    original cache classes are also preserved verbatim in
 *    `cache_creation_input_tokens` and `cache_read_input_tokens` so cost can be
 *    recomputed without re-deriving them.
 * 2. `response_cost` is `null` for unpriced events. Never 0. A consumer that
 *    sums response_cost gets the truth — that some events are uncounted.
 * 3. No prompt content. The payload never contains a `content` key. The
 *    `assertNoContent` guard below enforces this at runtime as a belt-and-
 *    suspenders check on top of the parser-level invariant.
 */
export function toLiteLLMPayload(input: LiteLLMInput): LiteLLMPayload {
  const { event, pricing, attribution } = input;
  const cache_hit = event.cache_read_tokens > 0;
  const prompt_tokens = event.input_tokens + event.cache_write_tokens + event.cache_read_tokens;
  const completion_tokens = event.output_tokens;
  const epochSeconds = Math.floor(new Date(event.ts).getTime() / 1000);

  const payload: LiteLLMPayload = {
    id: `${event.session_id}:${event.line_hash}`,
    call_type: 'completion',
    model: event.model,
    custom_llm_provider: 'anthropic',
    response_cost: pricing.priced ? pricing.cost : null,
    cache_hit,
    prompt_tokens,
    completion_tokens,
    total_tokens: prompt_tokens + completion_tokens,
    cache_creation_input_tokens: event.cache_write_tokens,
    cache_read_input_tokens: event.cache_read_tokens,
    startTime: epochSeconds,
    endTime: epochSeconds,
    metadata: {
      requester_metadata: {
        feature: attribution.tab_name,
        repo: event.repo,
        git_branch: event.git_branch,
        pr: attribution.pr_number,
        cost_category: attribution.cost_category,
      },
    },
  };

  assertNoContent(payload);
  return payload;
}

/**
 * Walk a payload and throw if any nested key is named `content`.
 *
 * Defends against future regressions: even if a refactor accidentally pulled
 * `message.content` through somewhere, this fires before the payload leaves
 * the function. Exposed so the receiver/sender can re-check too if paranoid.
 */
export function assertNoContent(value: unknown, path = '$'): void {
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) assertNoContent(value[i], `${path}[${i}]`);
    return;
  }
  for (const [k, v] of Object.entries(value)) {
    if (k === 'content') {
      throw new Error(
        `litellm payload contains forbidden "content" key at ${path}.${k} — never export prompt text`,
      );
    }
    assertNoContent(v, `${path}.${k}`);
  }
}
