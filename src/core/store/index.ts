import Database from 'better-sqlite3';
import { mkdirSync, readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  BranchRollup,
  CostCategory,
  DayRollup,
  ParsedEvent,
  PrCacheRow,
  PrInfo,
  PriceRow,
  Tab,
  TabRollup,
  Watermark,
} from '../types.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  id                 INTEGER PRIMARY KEY,
  session_id         TEXT    NOT NULL,
  line_hash          TEXT    NOT NULL,
  ts                 TEXT    NOT NULL,
  model              TEXT    NOT NULL,
  cwd                TEXT,
  repo               TEXT,
  git_branch         TEXT,
  input_tokens       INTEGER NOT NULL DEFAULT 0,
  output_tokens      INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
  UNIQUE (session_id, line_hash)
);
CREATE INDEX IF NOT EXISTS idx_events_ts    ON events(ts);
CREATE INDEX IF NOT EXISTS idx_events_repo  ON events(repo);
CREATE INDEX IF NOT EXISTS idx_events_model ON events(model);

CREATE TABLE IF NOT EXISTS tabs (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL,
  repo          TEXT,
  started_at    TEXT NOT NULL,
  ended_at      TEXT,
  note          TEXT,
  cost_category TEXT NOT NULL DEFAULT 'unclassified'
);

CREATE TABLE IF NOT EXISTS prices (
  model                TEXT NOT NULL,
  effective_date       TEXT NOT NULL,
  input_per_mtok       REAL NOT NULL,
  output_per_mtok      REAL NOT NULL,
  cache_write_per_mtok REAL NOT NULL,
  cache_read_per_mtok  REAL NOT NULL,
  PRIMARY KEY (model, effective_date)
);

CREATE TABLE IF NOT EXISTS ingest_watermarks (
  file_path   TEXT PRIMARY KEY,
  byte_offset INTEGER NOT NULL,
  head_hash   TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS pr_cache (
  repo        TEXT NOT NULL,
  branch      TEXT NOT NULL,
  pr_number   INTEGER,   -- NULL means "looked up, no PR"
  pr_title    TEXT,
  pr_state    TEXT,
  fetched_at  TEXT NOT NULL,
  PRIMARY KEY (repo, branch)
);

`;

// The attribution view is dropped + recreated on every Store init so the
// definition tracks the current code, even after schema migrations. This is
// safe because views hold no data — only the SELECT shape.
const ATTRIBUTION_VIEW = `
DROP VIEW IF EXISTS event_attribution;
CREATE VIEW event_attribution AS
SELECT
  e.id                                            AS event_id,
  e.session_id,
  e.line_hash,
  e.ts,
  e.model,
  e.cwd,
  e.repo,
  e.git_branch,
  e.input_tokens,
  e.output_tokens,
  e.cache_write_tokens,
  e.cache_read_tokens,
  t.id                                            AS tab_id,
  t.name                                          AS tab_name,
  t.started_at                                    AS tab_started_at,
  t.ended_at                                      AS tab_ended_at,
  t.repo                                          AS tab_repo,
  COALESCE(t.cost_category, 'unclassified')       AS cost_category
FROM events e
LEFT JOIN tabs t
  ON t.repo IS e.repo
  AND e.ts >= t.started_at
  AND (t.ended_at IS NULL OR e.ts < t.ended_at);
`;

export type StoreOptions = {
  dbPath?: string;
};

export type DailyRow = {
  date: string;
  events: number;
  input_tokens: number;
  output_tokens: number;
  cache_write_tokens: number;
  cache_read_tokens: number;
};

export type RepoRow = DailyRow & { repo: string | null };

export type EventRow = ParsedEvent;

export function defaultDbPath(): string {
  return join(homedir(), '.tokentab', 'tokentab.db');
}

export class Store {
  readonly db: Database.Database;

  constructor(opts: StoreOptions = {}) {
    const dbPath = opts.dbPath ?? defaultDbPath();
    if (dbPath !== ':memory:') {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = new Database(dbPath);
    if (dbPath !== ':memory:') {
      this.db.pragma('journal_mode = WAL');
    }
    this.db.exec(SCHEMA);
    this.migrate();
    this.db.exec(ATTRIBUTION_VIEW);
  }

  /**
   * Idempotent forward migrations for older DBs that predate columns added
   * after first ship. Each step checks the live schema before mutating.
   */
  private migrate(): void {
    const cols = this.db.prepare(`PRAGMA table_info(tabs)`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'cost_category')) {
      this.db.exec(
        `ALTER TABLE tabs ADD COLUMN cost_category TEXT NOT NULL DEFAULT 'unclassified'`,
      );
    }
  }

  close(): void {
    this.db.close();
  }

  insertEvents(events: ParsedEvent[]): number {
    if (events.length === 0) return 0;
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO events
        (session_id, line_hash, ts, model, cwd, repo, git_branch,
         input_tokens, output_tokens, cache_write_tokens, cache_read_tokens)
      VALUES (@session_id, @line_hash, @ts, @model, @cwd, @repo, @git_branch,
              @input_tokens, @output_tokens, @cache_write_tokens, @cache_read_tokens)
    `);
    const tx = this.db.transaction((rows: ParsedEvent[]) => {
      let inserted = 0;
      for (const r of rows) {
        const info = stmt.run(r);
        if (info.changes > 0) inserted++;
      }
      return inserted;
    });
    return tx(events);
  }

  getWatermark(filePath: string): Watermark | null {
    const row = this.db
      .prepare(`SELECT file_path, byte_offset, head_hash FROM ingest_watermarks WHERE file_path = ?`)
      .get(filePath) as Watermark | undefined;
    return row ?? null;
  }

  setWatermark(wm: Watermark): void {
    this.db
      .prepare(
        `INSERT INTO ingest_watermarks (file_path, byte_offset, head_hash)
         VALUES (?, ?, ?)
         ON CONFLICT(file_path) DO UPDATE SET
           byte_offset = excluded.byte_offset,
           head_hash   = excluded.head_hash`,
      )
      .run(wm.file_path, wm.byte_offset, wm.head_hash);
  }

  getPrices(): PriceRow[] {
    return this.db
      .prepare(
        `SELECT model, effective_date, input_per_mtok, output_per_mtok,
                cache_write_per_mtok, cache_read_per_mtok
         FROM prices`,
      )
      .all() as PriceRow[];
  }

  seedPricesFromFile(pricesJsonPath: string): number {
    const existing = this.db.prepare(`SELECT COUNT(*) AS n FROM prices`).get() as { n: number };
    if (existing.n > 0) return 0;
    const data = JSON.parse(readFileSync(pricesJsonPath, 'utf-8')) as { prices: PriceRow[] };
    const stmt = this.db.prepare(
      `INSERT OR IGNORE INTO prices
        (model, effective_date, input_per_mtok, output_per_mtok,
         cache_write_per_mtok, cache_read_per_mtok)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const tx = this.db.transaction((rows: PriceRow[]) => {
      let n = 0;
      for (const r of rows) {
        const info = stmt.run(
          r.model,
          r.effective_date,
          r.input_per_mtok,
          r.output_per_mtok,
          r.cache_write_per_mtok,
          r.cache_read_per_mtok,
        );
        if (info.changes > 0) n++;
      }
      return n;
    });
    return tx(data.prices);
  }

  /** Aggregate events for a date range (inclusive `from`, exclusive `to`), grouped by repo. */
  summarizeByRepo(fromIso: string, toIso: string): RepoRow[] {
    return this.db
      .prepare(
        `SELECT repo,
                substr(ts, 1, 10) AS date,
                COUNT(*) AS events,
                SUM(input_tokens) AS input_tokens,
                SUM(output_tokens) AS output_tokens,
                SUM(cache_write_tokens) AS cache_write_tokens,
                SUM(cache_read_tokens) AS cache_read_tokens
         FROM events
         WHERE ts >= ? AND ts < ?
         GROUP BY repo
         ORDER BY (SUM(input_tokens) + SUM(output_tokens) + SUM(cache_write_tokens) + SUM(cache_read_tokens)) DESC`,
      )
      .all(fromIso, toIso) as RepoRow[];
  }

  /** One row per UTC day, last `days` days. */
  summarizeByDay(days: number): DailyRow[] {
    return this.db
      .prepare(
        `SELECT substr(ts, 1, 10) AS date,
                COUNT(*) AS events,
                SUM(input_tokens) AS input_tokens,
                SUM(output_tokens) AS output_tokens,
                SUM(cache_write_tokens) AS cache_write_tokens,
                SUM(cache_read_tokens) AS cache_read_tokens
         FROM events
         GROUP BY date
         ORDER BY date DESC
         LIMIT ?`,
      )
      .all(days) as DailyRow[];
  }

  /** Stream all events overlapping `[from, to)` for client-side pricing. */
  eventsInRange(fromIso: string, toIso: string): EventRow[] {
    return this.db
      .prepare(
        `SELECT session_id, line_hash, ts, model, cwd, repo, git_branch,
                input_tokens, output_tokens, cache_write_tokens, cache_read_tokens
         FROM events
         WHERE ts >= ? AND ts < ?`,
      )
      .all(fromIso, toIso) as EventRow[];
  }

  // ─── Tabs ──────────────────────────────────────────────────────────

  getTab(id: number): Tab | null {
    const row = this.db
      .prepare(
        `SELECT id, name, repo, started_at, ended_at, note, cost_category
         FROM tabs WHERE id = ?`,
      )
      .get(id) as Tab | undefined;
    return row ?? null;
  }

  /** Find a tab by exact name; if multiple match, return the most recently started. */
  findTabByName(name: string): Tab | null {
    const row = this.db
      .prepare(
        `SELECT id, name, repo, started_at, ended_at, note, cost_category
         FROM tabs WHERE name = ?
         ORDER BY started_at DESC LIMIT 1`,
      )
      .get(name) as Tab | undefined;
    return row ?? null;
  }

  /** Open tab for a given repo (or NULL repo). Most recent if multiple exist. */
  getOpenTab(repo: string | null): Tab | null {
    const sql =
      repo === null
        ? `SELECT id, name, repo, started_at, ended_at, note, cost_category FROM tabs
           WHERE repo IS NULL AND ended_at IS NULL
           ORDER BY started_at DESC LIMIT 1`
        : `SELECT id, name, repo, started_at, ended_at, note, cost_category FROM tabs
           WHERE repo = ? AND ended_at IS NULL
           ORDER BY started_at DESC LIMIT 1`;
    const stmt = this.db.prepare(sql);
    const row = (repo === null ? stmt.get() : stmt.get(repo)) as Tab | undefined;
    return row ?? null;
  }

  /**
   * Open a new tab. Throws if an open tab already exists for this repo —
   * the CLI surfaces this as a user-visible error.
   */
  startTab(
    name: string,
    repo: string | null,
    opts: { note?: string | null; cost_category?: CostCategory; nowIso?: string } = {},
  ): Tab {
    const ts = opts.nowIso ?? new Date().toISOString();
    const open = this.getOpenTab(repo);
    if (open) {
      throw new Error(
        `tab already open for repo ${repo === null ? '(none)' : `"${repo}"`}: "${open.name}" (started ${open.started_at})`,
      );
    }
    const info = this.db
      .prepare(
        `INSERT INTO tabs (name, repo, started_at, ended_at, note, cost_category)
         VALUES (?, ?, ?, NULL, ?, ?)`,
      )
      .run(name, repo, ts, opts.note ?? null, opts.cost_category ?? 'unclassified');
    const tab = this.getTab(Number(info.lastInsertRowid));
    if (!tab) throw new Error('failed to read back inserted tab');
    return tab;
  }

  /** Set or change the cost_category of an existing tab. */
  classifyTab(tabId: number, category: CostCategory): Tab {
    this.db.prepare(`UPDATE tabs SET cost_category = ? WHERE id = ?`).run(category, tabId);
    const tab = this.getTab(tabId);
    if (!tab) throw new Error(`no tab with id ${tabId}`);
    return tab;
  }

  /** Stop a tab. No-op if already stopped. Returns the (now-closed) row. */
  stopTab(tabId: number, nowIso?: string): Tab {
    const ts = nowIso ?? new Date().toISOString();
    this.db
      .prepare(`UPDATE tabs SET ended_at = ? WHERE id = ? AND ended_at IS NULL`)
      .run(ts, tabId);
    const tab = this.getTab(tabId);
    if (!tab) throw new Error(`no tab with id ${tabId}`);
    return tab;
  }

  /** Stop any open tab in `repo`, then start a new one. Atomic. */
  switchTab(
    newName: string,
    repo: string | null,
    opts: { note?: string | null; cost_category?: CostCategory; nowIso?: string } = {},
  ): { stopped: Tab | null; started: Tab } {
    const ts = opts.nowIso ?? new Date().toISOString();
    return this.db.transaction(() => {
      const open = this.getOpenTab(repo);
      const stopped = open ? this.stopTab(open.id, ts) : null;
      const started = this.startTab(newName, repo, {
        note: opts.note,
        cost_category: opts.cost_category,
        nowIso: ts,
      });
      return { stopped, started };
    })();
  }

  /** Recent tabs with token rollups joined from the attribution view. */
  listTabsWithRollups(limit = 50): TabRollup[] {
    const rows = this.db
      .prepare(
        `SELECT
           t.id, t.name, t.repo, t.started_at, t.ended_at, t.note, t.cost_category,
           COUNT(ea.event_id) AS events,
           COALESCE(SUM(ea.input_tokens), 0)       AS input_tokens,
           COALESCE(SUM(ea.output_tokens), 0)      AS output_tokens,
           COALESCE(SUM(ea.cache_write_tokens), 0) AS cache_write_tokens,
           COALESCE(SUM(ea.cache_read_tokens), 0)  AS cache_read_tokens
         FROM tabs t
         LEFT JOIN event_attribution ea ON ea.tab_id = t.id
         GROUP BY t.id
         ORDER BY t.started_at DESC
         LIMIT ?`,
      )
      .all(limit) as Array<
      Tab & {
        events: number;
        input_tokens: number;
        output_tokens: number;
        cache_write_tokens: number;
        cache_read_tokens: number;
      }
    >;
    return rows.map((r) => ({
      tab: {
        id: r.id,
        name: r.name,
        repo: r.repo,
        started_at: r.started_at,
        ended_at: r.ended_at,
        note: r.note,
        cost_category: r.cost_category,
      },
      events: r.events,
      input_tokens: r.input_tokens,
      output_tokens: r.output_tokens,
      cache_write_tokens: r.cache_write_tokens,
      cache_read_tokens: r.cache_read_tokens,
    }));
  }

  /** Events with no covering tab, grouped by (repo, git_branch). */
  untaggedByBranch(fromIso?: string): BranchRollup[] {
    const where = fromIso ? `AND ts >= ?` : '';
    const params = fromIso ? [fromIso] : [];
    return this.db
      .prepare(
        `SELECT repo, git_branch,
                COUNT(*) AS events,
                SUM(input_tokens)       AS input_tokens,
                SUM(output_tokens)      AS output_tokens,
                SUM(cache_write_tokens) AS cache_write_tokens,
                SUM(cache_read_tokens)  AS cache_read_tokens,
                MAX(cwd)                AS sample_cwd
         FROM event_attribution
         WHERE tab_id IS NULL ${where}
         GROUP BY repo, git_branch
         ORDER BY (SUM(input_tokens) + SUM(output_tokens) + SUM(cache_write_tokens) + SUM(cache_read_tokens)) DESC`,
      )
      .all(...params) as BranchRollup[];
  }

  /**
   * Events in `[fromIso, toIso)` joined with their attribution from the view —
   * each row carries `tab_id`, `tab_name`, and `cost_category` (with
   * `cost_category = 'unclassified'` for uncovered events).
   */
  eventsWithAttributionInRange(
    fromIso: string,
    toIso: string,
  ): Array<EventRow & { tab_id: number | null; tab_name: string | null; cost_category: CostCategory }> {
    return this.db
      .prepare(
        `SELECT session_id, line_hash, ts, model, cwd, repo, git_branch,
                input_tokens, output_tokens, cache_write_tokens, cache_read_tokens,
                tab_id, tab_name, cost_category
         FROM event_attribution
         WHERE ts >= ? AND ts < ?`,
      )
      .all(fromIso, toIso) as Array<
      EventRow & { tab_id: number | null; tab_name: string | null; cost_category: CostCategory }
    >;
  }

  /** Events with no covering tab in `[fromIso, toIso)` — for per-event pricing. */
  untaggedEventsInRange(fromIso: string, toIso: string): EventRow[] {
    return this.db
      .prepare(
        `SELECT session_id, line_hash, ts, model, cwd, repo, git_branch,
                input_tokens, output_tokens, cache_write_tokens, cache_read_tokens
         FROM event_attribution
         WHERE tab_id IS NULL AND ts >= ? AND ts < ?`,
      )
      .all(fromIso, toIso) as EventRow[];
  }

  /** Every event grouped by (repo, git_branch), regardless of tabs. */
  allByBranch(fromIso?: string): BranchRollup[] {
    const where = fromIso ? `WHERE ts >= ?` : '';
    const params = fromIso ? [fromIso] : [];
    return this.db
      .prepare(
        `SELECT repo, git_branch,
                COUNT(*) AS events,
                SUM(input_tokens)       AS input_tokens,
                SUM(output_tokens)      AS output_tokens,
                SUM(cache_write_tokens) AS cache_write_tokens,
                SUM(cache_read_tokens)  AS cache_read_tokens,
                MAX(cwd)                AS sample_cwd
         FROM events
         ${where}
         GROUP BY repo, git_branch
         ORDER BY (SUM(input_tokens) + SUM(output_tokens) + SUM(cache_write_tokens) + SUM(cache_read_tokens)) DESC`,
      )
      .all(...params) as BranchRollup[];
  }

  allByDay(days: number): DayRollup[] {
    return this.db
      .prepare(
        `SELECT substr(ts, 1, 10) AS date,
                COUNT(*) AS events,
                SUM(input_tokens)       AS input_tokens,
                SUM(output_tokens)      AS output_tokens,
                SUM(cache_write_tokens) AS cache_write_tokens,
                SUM(cache_read_tokens)  AS cache_read_tokens
         FROM events
         GROUP BY date
         ORDER BY date DESC
         LIMIT ?`,
      )
      .all(days) as DayRollup[];
  }

  // ─── PR cache ─────────────────────────────────────────────────────

  getPrCache(): Map<string, PrCacheRow> {
    const rows = this.db
      .prepare(
        `SELECT repo, branch, pr_number, pr_title, pr_state, fetched_at FROM pr_cache`,
      )
      .all() as PrCacheRow[];
    const map = new Map<string, PrCacheRow>();
    for (const r of rows) map.set(`${r.repo}\x00${r.branch}`, r);
    return map;
  }

  upsertPrCache(repo: string, branch: string, pr: PrInfo | null, nowIso?: string): void {
    const ts = nowIso ?? new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO pr_cache (repo, branch, pr_number, pr_title, pr_state, fetched_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(repo, branch) DO UPDATE SET
           pr_number  = excluded.pr_number,
           pr_title   = excluded.pr_title,
           pr_state   = excluded.pr_state,
           fetched_at = excluded.fetched_at`,
      )
      .run(repo, branch, pr?.number ?? null, pr?.title ?? null, pr?.state ?? null, ts);
  }
}

/** Locate the bundled prices.json (lives at the package root). */
export function bundledPricesPath(): string {
  // dist/core/store/index.js -> ../../../prices.json
  // src/core/store/index.ts  -> ../../../prices.json
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, '../../..', 'prices.json'),
    join(here, '../../../..', 'prices.json'),
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  return candidates[0];
}
