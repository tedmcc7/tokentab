export type TokenCounts = {
  input_tokens: number;
  output_tokens: number;
  cache_write_tokens: number;
  cache_read_tokens: number;
};

export type ParsedEvent = TokenCounts & {
  ts: string;
  model: string;
  session_id: string;
  cwd: string | null;
  repo: string | null;
  git_branch: string | null;
  line_hash: string;
};

export type PriceRow = {
  model: string;
  effective_date: string;
  input_per_mtok: number;
  output_per_mtok: number;
  cache_write_per_mtok: number;
  cache_read_per_mtok: number;
};

export type Watermark = {
  file_path: string;
  byte_offset: number;
  head_hash: string;
};

export type PricingResult =
  | { priced: true; cost: number; effective_date: string }
  | { priced: false; reason: 'unpriced_model' | 'no_applicable_date' };

export type CostCategory = 'COGS' | 'OpEx' | 'unclassified';

export type Tab = {
  id: number;
  name: string;
  repo: string | null;
  started_at: string;
  ended_at: string | null;
  note: string | null;
  cost_category: CostCategory;
};

export type AttributedEvent = ParsedEvent & {
  tab_id: number | null;
  tab_name: string | null;
  cost_category: CostCategory;
};

/**
 * Faithful subset of LiteLLM's Standard Logging Payload — flat token fields
 * at top level, epoch-seconds timestamps. Shape mirrors
 * `examples/ramp_export_proof.mjs`, which is the reference receiver.
 */
export type LiteLLMPayload = {
  id: string;
  call_type: string;
  model: string;
  custom_llm_provider: string;
  response_cost: number | null;
  cache_hit: boolean;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  startTime: number;
  endTime: number;
  metadata: {
    requester_metadata: {
      feature: string | null;
      repo: string | null;
      git_branch: string | null;
      pr: number | null;
      cost_category: CostCategory;
    };
  };
};

export type TabRollup = {
  tab: Tab;
} & TokenCounts & { events: number };

export type BranchRollup = TokenCounts & {
  repo: string | null;
  git_branch: string | null;
  events: number;
  sample_cwd: string | null;
};

export type DayRollup = TokenCounts & {
  date: string;
  events: number;
};

export type PrInfo = {
  number: number;
  title: string;
  state: string;
};

export type PrCacheRow = {
  repo: string;
  branch: string;
  pr_number: number | null;
  pr_title: string | null;
  pr_state: string | null;
  fetched_at: string;
};
