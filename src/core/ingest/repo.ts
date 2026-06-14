import { spawnSync } from 'node:child_process';
import { basename } from 'node:path';

const cache = new Map<string, string | null>();

/**
 * Resolve a cwd to a normalized repo name. Tries `git -C <cwd> rev-parse
 * --show-toplevel` and returns its basename; falls back to basename(cwd).
 * Results are cached so we run git at most once per distinct cwd.
 */
export function normalizeRepo(cwd: string | null | undefined): string | null {
  if (!cwd) return null;
  if (cache.has(cwd)) return cache.get(cwd) ?? null;

  let result: string;
  const r = spawnSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (r.status === 0 && r.stdout) {
    result = basename(r.stdout.trim());
  } else {
    result = basename(cwd);
  }
  cache.set(cwd, result);
  return result;
}

/** Test-only: reset the per-cwd cache. */
export function _resetRepoCache(): void {
  cache.clear();
}
