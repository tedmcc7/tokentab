import type { PriceRow } from '../../src/core/types.js';
import type { ExportableEvent } from '../../src/core/export/litellm.js';

export const FIXTURE_PRICES: PriceRow[] = [
  {
    model: 'claude-opus-4-7',
    effective_date: '2025-01-01',
    input_per_mtok: 15,
    output_per_mtok: 75,
    cache_write_per_mtok: 18.75,
    cache_read_per_mtok: 1.5,
  },
  {
    model: 'claude-sonnet-4-6',
    effective_date: '2025-01-01',
    input_per_mtok: 3,
    output_per_mtok: 15,
    cache_write_per_mtok: 3.75,
    cache_read_per_mtok: 0.3,
  },
];

// Three deliberately diverse events: a normal call, a cache-heavy one (where
// naive summation would mis-cost by ~10x), and one whose model has no price
// row so the unpriced fallback path is exercised end-to-end.
export const FIXTURE_EVENTS: ExportableEvent[] = [
  {
    session_id: 'sess-normal',
    line_hash: 'hash-normal',
    ts: '2026-06-01T10:00:00.000Z',
    model: 'claude-opus-4-7',
    repo: 'repo-a',
    git_branch: 'main',
    input_tokens: 100,
    output_tokens: 50,
    cache_write_tokens: 0,
    cache_read_tokens: 0,
  },
  {
    session_id: 'sess-cache',
    line_hash: 'hash-cache',
    ts: '2026-06-01T11:00:00.000Z',
    model: 'claude-sonnet-4-6',
    repo: 'repo-a',
    git_branch: 'feat-cache',
    input_tokens: 3,
    output_tokens: 98,
    cache_write_tokens: 4_822,
    cache_read_tokens: 2_500_000,
  },
  {
    session_id: 'sess-unpriced',
    line_hash: 'hash-unpriced',
    ts: '2026-06-01T12:00:00.000Z',
    model: 'claude-mystery-9',
    repo: 'repo-b',
    git_branch: 'experimental',
    input_tokens: 100,
    output_tokens: 100,
    cache_write_tokens: 0,
    cache_read_tokens: 0,
  },
];
