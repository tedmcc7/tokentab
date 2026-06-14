import { describe, it, expect } from 'vitest';
import { parseLine, hashLine } from '../src/core/ingest/parser.js';

function makeLine(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    timestamp: '2026-04-23T03:11:23.863Z',
    sessionId: 'sess-abc',
    cwd: '/Users/me/repo',
    gitBranch: 'main',
    type: 'assistant',
    message: {
      model: 'claude-opus-4-7',
      role: 'assistant',
      content: 'this is the assistant reply text',
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_creation_input_tokens: 1_000,
        cache_read_input_tokens: 20_000,
      },
    },
    ...overrides,
  });
}

describe('parseLine', () => {
  it('parses a normal usage line and maps cache fields correctly', () => {
    const ev = parseLine(makeLine());
    expect(ev).not.toBeNull();
    expect(ev!.ts).toBe('2026-04-23T03:11:23.863Z');
    expect(ev!.session_id).toBe('sess-abc');
    expect(ev!.model).toBe('claude-opus-4-7');
    expect(ev!.cwd).toBe('/Users/me/repo');
    expect(ev!.git_branch).toBe('main');
    expect(ev!.input_tokens).toBe(100);
    expect(ev!.output_tokens).toBe(50);
    expect(ev!.cache_write_tokens).toBe(1_000);
    expect(ev!.cache_read_tokens).toBe(20_000);
  });

  it('parses a cache-heavy line where cache_read dwarfs everything else', () => {
    const ev = parseLine(
      makeLine({
        message: {
          model: 'claude-sonnet-4-6',
          usage: {
            input_tokens: 3,
            output_tokens: 98,
            cache_creation_input_tokens: 4_822,
            cache_read_input_tokens: 2_500_000,
          },
        },
      }),
    );
    expect(ev).not.toBeNull();
    expect(ev!.input_tokens).toBe(3);
    expect(ev!.cache_read_tokens).toBe(2_500_000);
  });

  it('returns null for a line without message.usage', () => {
    const userLine = JSON.stringify({
      timestamp: '2026-04-23T03:11:00Z',
      sessionId: 'sess-abc',
      type: 'user',
      message: { role: 'user', content: 'hello' },
    });
    expect(parseLine(userLine)).toBeNull();
  });

  it('returns null for malformed JSON without throwing', () => {
    expect(parseLine('{not json')).toBeNull();
    expect(parseLine('')).toBeNull();
  });

  it('returns null when required fields are missing', () => {
    expect(parseLine(makeLine({ timestamp: undefined }))).toBeNull();
    expect(parseLine(makeLine({ sessionId: undefined }))).toBeNull();
    expect(parseLine(makeLine({ message: { usage: { input_tokens: 1 } } }))).toBeNull();
  });

  it('degrades gracefully when optional fields are missing', () => {
    const ev = parseLine(makeLine({ cwd: undefined, gitBranch: undefined }));
    expect(ev).not.toBeNull();
    expect(ev!.cwd).toBeNull();
    expect(ev!.git_branch).toBeNull();
  });

  it('treats missing token counts as zero', () => {
    const ev = parseLine(
      makeLine({
        message: {
          model: 'claude-opus-4-7',
          usage: { input_tokens: 10 },
        },
      }),
    );
    expect(ev).not.toBeNull();
    expect(ev!.input_tokens).toBe(10);
    expect(ev!.output_tokens).toBe(0);
    expect(ev!.cache_write_tokens).toBe(0);
    expect(ev!.cache_read_tokens).toBe(0);
  });

  it('PRIVACY: never returns message.content in the parsed event', () => {
    const SECRET = 'SECRET_PROMPT_DO_NOT_LEAK_ABCDEFG';
    const ev = parseLine(
      makeLine({
        message: {
          model: 'claude-opus-4-7',
          content: SECRET,
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      }),
    );
    expect(ev).not.toBeNull();
    expect(JSON.stringify(ev)).not.toContain(SECRET);
  });

  it('hashLine is stable and 16 hex chars (dedupe key compactness)', () => {
    const a = hashLine('hello world');
    const b = hashLine('hello world');
    const c = hashLine('hello world!');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
  });
});
