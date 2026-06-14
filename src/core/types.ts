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
