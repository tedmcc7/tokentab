import { spawnSync } from 'node:child_process';
import type { PrInfo } from '../types.js';

export type GhResult =
  | { ok: true; stdout: string }
  | { ok: false; reason: 'not_installed' }
  | { ok: false; reason: 'error'; stderr: string };

/** Runs `gh <args>` from `cwd`. Returns a tagged result so callers can branch on failure mode. */
export type GhRunner = (args: string[], cwd: string | null) => GhResult;

export type ResolveResult =
  | { ok: true; prs: Map<string, PrInfo | null> }
  | { ok: false; reason: 'gh_missing' | 'gh_error'; partial: Map<string, PrInfo | null> };

export type BranchKey = { repo: string; branch: string; sample_cwd: string | null };

export const prKey = (repo: string, branch: string): string => `${repo}\x00${branch}`;

export function defaultGhRunner(): GhRunner {
  return (args, cwd) => {
    const r = spawnSync('gh', args, {
      cwd: cwd ?? undefined,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (r.error && (r.error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { ok: false, reason: 'not_installed' };
    }
    if (r.status !== 0) {
      return { ok: false, reason: 'error', stderr: r.stderr ?? '' };
    }
    return { ok: true, stdout: r.stdout ?? '' };
  };
}

/**
 * Resolve PR for one (repo, branch). Returns `null` if the branch has no PR.
 * Throws `GhMissing` if `gh` isn't installed; throws `GhError` for other gh failures.
 * Callers using this directly should catch; `resolvePrs` below already does.
 */
export class GhMissing extends Error {
  constructor() {
    super('gh CLI not installed');
  }
}
export class GhError extends Error {
  constructor(public readonly stderr: string) {
    super(`gh failed: ${stderr.trim().split('\n')[0] ?? 'unknown error'}`);
  }
}

export function resolveOnePr(
  branch: string,
  cwd: string | null,
  run: GhRunner,
): PrInfo | null {
  const r = run(
    [
      'pr',
      'list',
      '--head',
      branch,
      '--state',
      'all',
      '--json',
      'number,title,state',
      '--limit',
      '1',
    ],
    cwd,
  );
  if (!r.ok) {
    if (r.reason === 'not_installed') throw new GhMissing();
    throw new GhError(r.stderr);
  }
  let arr: unknown;
  try {
    arr = JSON.parse(r.stdout);
  } catch {
    return null;
  }
  if (!Array.isArray(arr) || arr.length === 0) return null;
  const first = arr[0] as Partial<PrInfo>;
  if (typeof first.number !== 'number') return null;
  return {
    number: first.number,
    title: typeof first.title === 'string' ? first.title : '',
    state: typeof first.state === 'string' ? first.state : '',
  };
}

/**
 * Resolve a batch of (repo, branch) keys to PR info. The first `gh` failure
 * short-circuits: we never want to spend 25s on 50 failing gh calls. Returns
 * any partial results gathered before the failure.
 */
export function resolvePrs(
  branches: BranchKey[],
  run: GhRunner = defaultGhRunner(),
): ResolveResult {
  const out = new Map<string, PrInfo | null>();
  for (const b of branches) {
    try {
      const pr = resolveOnePr(b.branch, b.sample_cwd, run);
      out.set(prKey(b.repo, b.branch), pr);
    } catch (err) {
      if (err instanceof GhMissing) return { ok: false, reason: 'gh_missing', partial: out };
      if (err instanceof GhError) return { ok: false, reason: 'gh_error', partial: out };
      throw err;
    }
  }
  return { ok: true, prs: out };
}
