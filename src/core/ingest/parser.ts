import { createHash } from 'node:crypto';
import type { ParsedEvent } from '../types.js';

/**
 * Parse one JSONL line into a `ParsedEvent`.
 *
 * Returns `null` for lines without a `message.usage` block (user messages,
 * tool results, malformed JSON, etc.). Never throws.
 *
 * Privacy invariant: this function reads ONLY `usage` and metadata fields
 * (`timestamp`, `sessionId`, `cwd`, `gitBranch`, `message.model`). It never
 * touches `message.content`. Do not regress this — there is a test that
 * pins the behaviour.
 */
export function parseLine(line: string): Omit<ParsedEvent, 'repo'> | null {
  if (!line || line.length === 0) return null;

  let obj: unknown;
  try {
    obj = JSON.parse(line);
  } catch {
    return null;
  }

  if (!isRecord(obj)) return null;

  const message = obj.message;
  if (!isRecord(message)) return null;

  const usage = message.usage;
  if (!isRecord(usage)) return null;

  const ts = typeof obj.timestamp === 'string' ? obj.timestamp : null;
  const sessionId = typeof obj.sessionId === 'string' ? obj.sessionId : null;
  const model = typeof message.model === 'string' ? message.model : null;
  if (!ts || !sessionId || !model) return null;

  return {
    ts,
    model,
    session_id: sessionId,
    cwd: typeof obj.cwd === 'string' ? obj.cwd : null,
    git_branch: typeof obj.gitBranch === 'string' ? obj.gitBranch : null,
    input_tokens: numberOrZero(usage.input_tokens),
    output_tokens: numberOrZero(usage.output_tokens),
    cache_write_tokens: numberOrZero(usage.cache_creation_input_tokens),
    cache_read_tokens: numberOrZero(usage.cache_read_input_tokens),
    line_hash: hashLine(line),
  };
}

export function hashLine(line: string): string {
  return createHash('sha256').update(line).digest('hex').slice(0, 16);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function numberOrZero(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}
