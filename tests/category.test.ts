import { describe, it, expect } from 'vitest';
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

describe('cost_category — attribution view', () => {
  it('defaults a new tab to "unclassified"', () => {
    const store = new Store({ dbPath: ':memory:' });
    const tab = store.startTab('feature', 'repo-a');
    expect(tab.cost_category).toBe('unclassified');
  });

  it('startTab accepts COGS / OpEx and persists the value', () => {
    const store = new Store({ dbPath: ':memory:' });
    const cogs = store.startTab('a', 'repo-a', { cost_category: 'COGS' });
    const opex = store.startTab('b', 'repo-b', { cost_category: 'OpEx' });
    expect(cogs.cost_category).toBe('COGS');
    expect(opex.cost_category).toBe('OpEx');
  });

  it('classifyTab updates an existing tab in place', () => {
    const store = new Store({ dbPath: ':memory:' });
    const t = store.startTab('a', 'repo-a');
    const updated = store.classifyTab(t.id, 'COGS');
    expect(updated.cost_category).toBe('COGS');
    expect(store.getTab(t.id)?.cost_category).toBe('COGS');
  });

  it('events inherit their covering tab\'s cost_category via the view', () => {
    const store = new Store({ dbPath: ':memory:' });
    store.startTab('build-feature', 'repo-a', {
      cost_category: 'COGS',
      nowIso: '2026-06-14T10:00:00.000Z',
    });
    store.insertEvents([
      evt({ repo: 'repo-a', ts: '2026-06-14T10:30:00.000Z' }),
      evt({ repo: 'repo-a', ts: '2026-06-14T11:00:00.000Z' }),
    ]);
    const events = store.eventsWithAttributionInRange(
      '2026-06-14T00:00:00.000Z',
      '2026-06-15T00:00:00.000Z',
    );
    expect(events).toHaveLength(2);
    for (const e of events) expect(e.cost_category).toBe('COGS');
  });

  it('events with no covering tab default to "unclassified" via COALESCE', () => {
    const store = new Store({ dbPath: ':memory:' });
    store.insertEvents([evt({ repo: 'repo-a', ts: '2026-06-14T15:00:00.000Z' })]);
    const events = store.eventsWithAttributionInRange(
      '2026-06-14T00:00:00.000Z',
      '2026-06-15T00:00:00.000Z',
    );
    expect(events).toHaveLength(1);
    expect(events[0].cost_category).toBe('unclassified');
    expect(events[0].tab_id).toBeNull();
  });

  it('reclassifying a tab re-attributes its events in the view immediately', () => {
    const store = new Store({ dbPath: ':memory:' });
    const t = store.startTab('feat', 'repo-a', {
      cost_category: 'OpEx',
      nowIso: '2026-06-14T10:00:00.000Z',
    });
    store.insertEvents([evt({ repo: 'repo-a', ts: '2026-06-14T10:30:00.000Z' })]);
    const before = store.eventsWithAttributionInRange(
      '2026-06-14T00:00:00.000Z',
      '2026-06-15T00:00:00.000Z',
    );
    expect(before[0].cost_category).toBe('OpEx');

    store.classifyTab(t.id, 'COGS');
    const after = store.eventsWithAttributionInRange(
      '2026-06-14T00:00:00.000Z',
      '2026-06-15T00:00:00.000Z',
    );
    expect(after[0].cost_category).toBe('COGS');
  });
});
