import Database from 'better-sqlite3';
import { mkdirSync, readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ParsedEvent, PriceRow, Watermark } from '../types.js';

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
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  repo        TEXT,
  started_at  TEXT NOT NULL,
  ended_at    TEXT,
  note        TEXT
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
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(SCHEMA);
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
