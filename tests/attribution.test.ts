import { describe, it, expect, beforeEach } from 'vitest';
import { Store } from '../src/core/store/index.js';
import type { ParsedEvent } from '../src/core/types.js';

function evt(overrides: Partial<ParsedEvent> = {}): ParsedEvent {
  return {
    session_id: 'sess-x',
    line_hash: Math.random().toString(36).slice(2, 18),
    ts: '2026-06-14T10:30:00.000Z',
    model: 'claude-opus-4-7',
    cwd: '/repo',
    repo: 'repo-a',
    git_branch: 'main',
    input_tokens: 10,
    output_tokens: 10,
    cache_write_tokens: 0,
    cache_read_tokens: 0,
    ...overrides,
  };
}

describe('attribution — interval edge cases', () => {
  let store: Store;
  let tabId: number;

  beforeEach(() => {
    store = new Store({ dbPath: ':memory:' });
    // Closed tab in repo-a covering [10:00, 12:00).
    const tab = store.startTab('feature', 'repo-a', { nowIso: '2026-06-14T10:00:00.000Z' });
    tabId = tab.id;
    store.stopTab(tab.id, '2026-06-14T12:00:00.000Z');
  });

  it('attributes an event exactly at started_at (inclusive lower bound)', () => {
    store.insertEvents([evt({ ts: '2026-06-14T10:00:00.000Z' })]);
    const tabs = store.listTabsWithRollups();
    expect(tabs[0].events).toBe(1);
  });

  it('does NOT attribute an event exactly at ended_at (exclusive upper bound)', () => {
    store.insertEvents([evt({ ts: '2026-06-14T12:00:00.000Z' })]);
    const tabs = store.listTabsWithRollups();
    expect(tabs[0].events).toBe(0);
    const untagged = store.untaggedByBranch();
    expect(untagged.find((r) => r.git_branch === 'main')?.events).toBe(1);
  });

  it('attributes events inside the window', () => {
    store.insertEvents([
      evt({ ts: '2026-06-14T10:00:00.001Z' }),
      evt({ ts: '2026-06-14T11:30:00.000Z' }),
      evt({ ts: '2026-06-14T11:59:59.999Z' }),
    ]);
    const tabs = store.listTabsWithRollups();
    expect(tabs[0].events).toBe(3);
  });

  it('does NOT attribute events outside the window', () => {
    store.insertEvents([
      evt({ ts: '2026-06-14T09:00:00.000Z' }), // before
      evt({ ts: '2026-06-14T13:00:00.000Z' }), // after
    ]);
    expect(store.listTabsWithRollups()[0].events).toBe(0);
  });

  it('does not cross repos: an event in repo-b does not match a tab in repo-a', () => {
    store.insertEvents([evt({ repo: 'repo-b', ts: '2026-06-14T11:00:00.000Z' })]);
    expect(store.listTabsWithRollups().find((r) => r.tab.id === tabId)?.events).toBe(0);
  });

  it('open tab matches every event at or after its started_at', () => {
    const open = store.startTab('ongoing', 'repo-a', { nowIso: '2026-06-14T14:00:00.000Z' });
    store.insertEvents([
      evt({ ts: '2026-06-14T13:59:59.999Z' }), // before — untagged
      evt({ ts: '2026-06-14T14:00:00.000Z' }), // at start — tagged
      evt({ ts: '2026-06-15T08:00:00.000Z' }), // way after — tagged (still open)
    ]);
    const ongoing = store.listTabsWithRollups().find((r) => r.tab.id === open.id);
    expect(ongoing?.events).toBe(2);
  });

  it('parallel tabs in different repos attribute only their own repo', () => {
    const tabB = store.startTab('feature-b', 'repo-b', { nowIso: '2026-06-14T10:30:00.000Z' });
    store.stopTab(tabB.id, '2026-06-14T11:30:00.000Z');
    store.insertEvents([
      evt({ repo: 'repo-a', ts: '2026-06-14T11:00:00.000Z' }),
      evt({ repo: 'repo-b', ts: '2026-06-14T11:00:00.000Z' }),
    ]);
    const tabs = store.listTabsWithRollups();
    expect(tabs.find((r) => r.tab.id === tabId)?.events).toBe(1);
    expect(tabs.find((r) => r.tab.id === tabB.id)?.events).toBe(1);
  });
});

describe('attribution — tab CRUD invariants', () => {
  it('refuses a second open tab in the same repo', () => {
    const store = new Store({ dbPath: ':memory:' });
    store.startTab('first', 'repo-a');
    expect(() => store.startTab('second', 'repo-a')).toThrow(/already open/);
  });

  it('allows a second open tab in a different repo', () => {
    const store = new Store({ dbPath: ':memory:' });
    store.startTab('first', 'repo-a');
    expect(() => store.startTab('second', 'repo-b')).not.toThrow();
  });

  it('switchTab stops the open tab and starts a new one at the same instant', () => {
    const store = new Store({ dbPath: ':memory:' });
    const first = store.startTab('first', 'repo-a', { nowIso: '2026-06-14T10:00:00.000Z' });
    const { stopped, started } = store.switchTab('second', 'repo-a', {
      nowIso: '2026-06-14T11:00:00.000Z',
    });
    expect(stopped?.id).toBe(first.id);
    expect(stopped?.ended_at).toBe('2026-06-14T11:00:00.000Z');
    expect(started.started_at).toBe('2026-06-14T11:00:00.000Z');
    // boundary instant belongs to the *new* tab (>= started_at)
    store.insertEvents([evt({ repo: 'repo-a', ts: '2026-06-14T11:00:00.000Z' })]);
    const tabs = store.listTabsWithRollups();
    expect(tabs.find((r) => r.tab.id === started.id)?.events).toBe(1);
    expect(tabs.find((r) => r.tab.id === first.id)?.events).toBe(0);
  });
});

describe('branch fallback', () => {
  it('events without a covering tab show up under their git_branch', () => {
    const store = new Store({ dbPath: ':memory:' });
    store.insertEvents([
      evt({ repo: 'repo-a', git_branch: 'main', ts: '2026-06-14T15:00:00.000Z' }),
      evt({ repo: 'repo-a', git_branch: 'main', ts: '2026-06-14T15:01:00.000Z' }),
      evt({ repo: 'repo-a', git_branch: 'feat-x', ts: '2026-06-14T15:02:00.000Z' }),
    ]);
    const untagged = store.untaggedByBranch();
    expect(untagged.find((r) => r.git_branch === 'main')?.events).toBe(2);
    expect(untagged.find((r) => r.git_branch === 'feat-x')?.events).toBe(1);
  });

  it('tab-attributed events disappear from untaggedByBranch', () => {
    const store = new Store({ dbPath: ':memory:' });
    store.startTab('feature', 'repo-a', { nowIso: '2026-06-14T10:00:00.000Z' });
    store.insertEvents([
      evt({ repo: 'repo-a', git_branch: 'main', ts: '2026-06-14T11:00:00.000Z' }),
    ]);
    const untagged = store.untaggedByBranch();
    expect(untagged.find((r) => r.git_branch === 'main')).toBeUndefined();
  });
});
