import { describe, it, expect } from 'vitest';
import { resolvePrs, prKey, type GhRunner } from '../src/core/pr/gh.js';

const fakeRunner = (
  responder: (args: string[], cwd: string | null) => ReturnType<GhRunner>,
): GhRunner => responder;

const branchKey = (repo: string, branch: string, cwd: string | null = '/r') => ({
  repo,
  branch,
  sample_cwd: cwd,
});

describe('resolvePrs — `gh` mocked', () => {
  it('parses PR info from gh stdout', () => {
    const run = fakeRunner(() => ({
      ok: true,
      stdout: JSON.stringify([{ number: 42, title: 'Add session middleware', state: 'OPEN' }]),
    }));
    const result = resolvePrs([branchKey('myrepo', 'feat-auth')], run);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.prs.get(prKey('myrepo', 'feat-auth'))).toEqual({
        number: 42,
        title: 'Add session middleware',
        state: 'OPEN',
      });
    }
  });

  it('returns null for a branch with no PR (empty array from gh)', () => {
    const run = fakeRunner(() => ({ ok: true, stdout: '[]' }));
    const result = resolvePrs([branchKey('myrepo', 'main')], run);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.prs.get(prKey('myrepo', 'main'))).toBeNull();
    }
  });

  it('falls back to gh_missing when gh is not installed', () => {
    const run = fakeRunner(() => ({ ok: false, reason: 'not_installed' }));
    const result = resolvePrs([branchKey('myrepo', 'feat-auth')], run);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('gh_missing');
  });

  it('falls back to gh_error when gh returns non-zero (e.g. not authed)', () => {
    const run = fakeRunner(() => ({ ok: false, reason: 'error', stderr: 'not logged in' }));
    const result = resolvePrs([branchKey('myrepo', 'feat-auth')], run);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('gh_error');
  });

  it('runs gh from the branch sample_cwd so `gh` finds the right repo', () => {
    const seenCwds: Array<string | null> = [];
    const run: GhRunner = (_args, cwd) => {
      seenCwds.push(cwd);
      return { ok: true, stdout: '[]' };
    };
    resolvePrs(
      [
        branchKey('myrepo', 'feat-auth', '/home/u/myrepo'),
        branchKey('otherproj', 'main', '/home/u/otherproj'),
      ],
      run,
    );
    expect(seenCwds).toEqual(['/home/u/myrepo', '/home/u/otherproj']);
  });

  it('passes the correct gh args for branch -> PR lookup', () => {
    let seenArgs: string[] = [];
    const run: GhRunner = (args) => {
      seenArgs = args;
      return { ok: true, stdout: '[]' };
    };
    resolvePrs([branchKey('myrepo', 'feat-auth')], run);
    expect(seenArgs).toContain('--head');
    expect(seenArgs[seenArgs.indexOf('--head') + 1]).toBe('feat-auth');
    expect(seenArgs).toContain('--json');
    expect(seenArgs).toContain('--state');
  });

  it('treats malformed gh JSON output as "no PR" (degrades gracefully)', () => {
    const run = fakeRunner(() => ({ ok: true, stdout: 'not json at all' }));
    const result = resolvePrs([branchKey('myrepo', 'feat')], run);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.prs.get(prKey('myrepo', 'feat'))).toBeNull();
  });

  it('short-circuits on first failure but preserves partial results', () => {
    let call = 0;
    const run: GhRunner = () => {
      call++;
      if (call === 1) return { ok: true, stdout: JSON.stringify([{ number: 1, title: 'a', state: 'OPEN' }]) };
      return { ok: false, reason: 'error', stderr: 'auth required' };
    };
    const result = resolvePrs(
      [branchKey('r', 'a'), branchKey('r', 'b'), branchKey('r', 'c')],
      run,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.partial.get(prKey('r', 'a'))).toEqual({ number: 1, title: 'a', state: 'OPEN' });
      expect(result.partial.has(prKey('r', 'b'))).toBe(false);
      expect(call).toBe(2); // stopped after the failure
    }
  });
});
