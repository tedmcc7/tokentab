# Architecture

TokenTab has one job: take token-usage events and attribute them to a **unit of work**, then
price and display the result. Everything below is in service of that.

This doc is the design Claude Code should build against. It is intentionally opinionated so
the build stays coherent; deviations are fine if they're better, but record them in
`CLAUDE.md`.

---

## 1. The attribution matrix

The "matrix" is two questions crossed together:

1. **What unit do we attribute spend to?** (the row)
2. **Where does the usage signal come from?** (the column)

Each cell is a level of effort and fidelity. We climb the matrix over the milestones in
`BUILD_PLAN.md`; we do **not** try to fill it all at once.

| Attribution unit ↓ / Source → | **A. Local JSONL logs** (batch ingest) | **B. Claude Code hooks** (event-time) | **C. OpenTelemetry / OTLP** (real-time stream) |
|---|---|---|---|
| **1. Manual tag ("tab")** | Map each usage event to the tab active during its timestamp interval. ← **start here (M1)** | Hook stamps the active tab at prompt time for exact, race-free attribution (M3) | OTLP metrics tagged with active tab as an attribute (M4+) |
| **2. Git branch** | `gitBranch` is already on each JSONL line — group by it. Nearly free (M2) | Hook records branch at session start (M3) | Branch added as a metric attribute (M4+) |
| **3. Pull request** | Resolve branch → PR via `gh` CLI, roll branch costs up to the PR (M2) | Same, refreshed on session start (M3) | PR id as attribute; live PR cost (M4+) |
| **4. Session / day** | Trivial group-by; the baseline every other tool stops at (M1) | n/a | n/a |

**Reading the matrix:** the *rows* are the product (what the user thinks in), the *columns*
are implementation strata (how good the signal is). Ship row 1 + row 4 on column A first;
that alone beats existing tools because of the tag axis. Then add rows 2–3 (also column A,
cheap). Columns B and C are the **automation upgrades** that make tagging effortless and
eventually real-time.

### Why this ordering

- **Column A (JSONL) needs zero setup** and works retroactively on logs you already have —
  great first-run demo, great for stars.
- **Column B (hooks)** removes the "I forgot to `tt start`" failure mode by letting Claude
  Code tell us the context at the exact moment of each prompt.
- **Column C (OTel)** is the "real" telemetry path for live dashboards and, later, team use —
  but it requires the user to set env vars, so it's opt-in and last.

---

## 2. Core concepts

**Event** — one model API call. The atomic unit of spend. Derived from one JSONL line that
has a `message.usage`. Has tokens (by class), a timestamp, model, session id, cwd, and branch.

**Tab** — a named, time-bounded cost bucket the user opens and closes (`tt start`/`tt stop`).
The headline feature. A tab belongs to a repo and has an open interval `[started_at, ended_at)`.

**Attribution** — the mapping from an Event to a unit (tab, branch, PR, session). One event
can roll up to several units at once (it happened *on branch X*, *during tab Y*, *in session
Z*). We store the raw event once and compute rollups in queries/views, so we never lose
fidelity.

**Cost** — derived, never stored as truth. `cost = Σ (tokens_of_class × price_of_class)` over
the four token classes, using the price table for that event's model at that date.

---

## 3. Data model (SQLite)

Local SQLite via `better-sqlite3`. Three tables plus a couple of views.

```sql
-- One row per model call. Idempotent: (session_id, line_hash) is unique so re-ingest is safe.
CREATE TABLE events (
  id                 INTEGER PRIMARY KEY,
  session_id         TEXT    NOT NULL,
  line_hash          TEXT    NOT NULL,           -- dedupe key
  ts                 TEXT    NOT NULL,           -- ISO 8601, UTC
  model              TEXT    NOT NULL,
  cwd                TEXT,
  repo               TEXT,                        -- normalized repo root (basename or git toplevel)
  git_branch         TEXT,
  input_tokens       INTEGER NOT NULL DEFAULT 0,
  output_tokens      INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,  -- cache_creation_input_tokens
  cache_read_tokens  INTEGER NOT NULL DEFAULT 0,  -- cache_read_input_tokens
  UNIQUE (session_id, line_hash)
);

-- Named cost buckets the user opens/closes.
CREATE TABLE tabs (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  repo        TEXT,
  started_at  TEXT NOT NULL,
  ended_at    TEXT,                               -- NULL = still open
  note        TEXT
);

-- Per-model, per-date pricing. Seeded from a checked-in JSON; user-overridable.
CREATE TABLE prices (
  model               TEXT NOT NULL,
  effective_date      TEXT NOT NULL,              -- prices change; pick the latest <= event date
  input_per_mtok      REAL NOT NULL,
  output_per_mtok     REAL NOT NULL,
  cache_write_per_mtok REAL NOT NULL,
  cache_read_per_mtok  REAL NOT NULL,
  PRIMARY KEY (model, effective_date)
);
```

**Attribution is a query, not a column.** An event belongs to a tab when
`event.repo = tab.repo AND event.ts ∈ [tab.started_at, tab.ended_at)`. Branch and session
attribution are direct group-bys. This keeps the model tiny and means a single event can be
viewed through any lens without duplication.

---

## 4. The pricing engine (don't get this wrong)

Token counts in the logs are real, but **summing raw tokens is meaningless** because the four
classes have wildly different prices:

- `cache_read` tokens are ~10% of input price,
- `cache_write` tokens are ~125% of input price,
- and in a long Claude Code session cache reads can dwarf everything else.

This is why naive trackers report costs that are off by large factors. TokenTab prices each
class separately:

```
cost(event) =
    input_tokens        / 1e6 * price.input_per_mtok
  + output_tokens       / 1e6 * price.output_per_mtok
  + cache_write_tokens  / 1e6 * price.cache_write_per_mtok
  + cache_read_tokens   / 1e6 * price.cache_read_per_mtok
```

Rules:

- Price table is **checked into the repo** as `prices.json` and seeded into the DB; users can
  override per model/date. Never hardcode a single rate.
- Select the price row with the latest `effective_date <= event.ts` for that model. Prices
  change; historical events keep their historical cost.
- If a model has no price row, surface the event as **"unpriced"** in the UI rather than
  silently charging $0. Honesty beats a wrong number.
- Show tokens *and* dollars everywhere. Some users only trust tokens.

> Sanity-check the engine against Claude Code's own `/usage` and `/cost` output during
> development; treat any large divergence as a bug in the pricing or ingest, not a rounding
> issue.

---

## 5. Components

```
                ┌──────────────────────────────────────────────┐
                │                  TokenTab                     │
                │                                              │
  ~/.claude/    │   ┌─────────┐   ┌─────────┐   ┌──────────┐  │
  projects/*.jsonl ─▶│ ingest  │──▶│ SQLite  │◀──│   CLI    │  │  tt start/stop/ls/today
                │   │(collector)│  │  store  │   │ (tt)     │  │
                │   └─────────┘   └────┬────┘   └──────────┘  │
  Claude Code   │        ▲              │                      │
  hooks ────────┼────────┘         ┌────▼─────┐                │
                │                  │ local API │──▶ React/Vite  │  dashboard at
  OTLP (later) ─┼─────────────────▶│ (serve)   │   dashboard   │  localhost:4317-ish
                │                  └──────────┘                │
                └──────────────────────────────────────────────┘
```

- **Collector / ingest** — reads new JSONL lines since last watermark, parses `message.usage`,
  normalizes repo + branch, dedupes, writes `events`. Runs on `tt` startup and can `--watch`.
- **Store** — SQLite. Single file at `~/.tokentab/tokentab.db`. Survives Claude Code log
  rotation/deletion because we own it.
- **CLI (`tt`)** — `start`, `stop`, `ls`, `today`, `report`, `serve`, `ingest`. Thin layer
  over store + collector.
- **Local API + dashboard** — `tt serve` (or `npx tokentab`) starts a tiny HTTP server that
  exposes read-only JSON endpoints and serves the built React app. Endpoints map to the views:
  `/api/tabs`, `/api/branches`, `/api/summary?group=tab|branch|pr|day`, `/api/events`.
- **Hooks (M3)** — small shell scripts wired into Claude Code's `SessionStart` and
  `UserPromptSubmit` hooks that write the active tab + branch into a context file the
  collector reads, making attribution exact instead of timestamp-inferred.
- **OTel receiver (M4+)** — optional OTLP endpoint that ingests `claude_code.token.usage` /
  `claude_code.cost.usage` metrics for real-time updates.

---

## 6. Tech stack

- **Language:** TypeScript everywhere (one language for CLI + server + UI lowers the
  contributor barrier and matches the ccusage ecosystem).
- **Runtime:** Node ≥ 20. Distributed on npm; `npx tokentab` must work with zero global install.
- **Store:** SQLite via `better-sqlite3` (sync, fast, no daemon).
- **CLI:** a light framework (`commander` or `cac`); keep commands obvious.
- **Server:** minimal (`hono` or `express`) serving JSON + static dashboard build.
- **Dashboard:** React + Vite, charts via **Recharts**, styling via Tailwind. Single-page,
  no router needed initially. The built assets ship inside the npm package so the dashboard
  works offline.
- **Testing:** `vitest`. The ingest parser and pricing engine get real unit tests with
  fixture JSONL lines — these are the parts that are easy to get subtly wrong.

---

## 7. Automating the tag (the part you actually asked about)

Manual `tt start`/`tt stop` is the v1 because it's unambiguous and zero-magic. Three automation
rungs build on top, in order of ambition:

1. **Branch fallback (M2, free).** If no tab is open, attribute to `git_branch`. You already
   get per-branch costs with no behavior change. For many people this is enough.

2. **Hook-driven auto-tab (M3).** A `SessionStart`/`UserPromptSubmit` hook writes the current
   branch + any open tab to `~/.tokentab/active.json`. The collector trusts that file over
   timestamp inference, eliminating the "I forgot to start a tab" and clock-skew problems. A
   config option can **auto-open a tab named after the branch** the first time Claude Code
   touches a new branch — so creating a branch *is* opening a tab.

3. **Intent detection (M5, experimental).** Heuristics that propose a tab without you naming
   one: a new branch off `main`, a burst of new files, or a first prompt that reads like
   "let's build X". Always *propose, never silently rename* — show it in the dashboard as a
   suggested tab the user accepts. This is the "Claude Code auto-detects you're building
   something new" idea, kept honest by keeping a human in the loop.

The guiding principle: **manual is the source of truth; automation only ever proposes.** That's
what keeps the numbers trustworthy, which is the entire value of a spend tool.

---

## 8. Privacy & safety

- 100% local by default. No network calls in the JSONL/hook path. The OTel path only talks to
  a localhost receiver unless the user explicitly points it elsewhere.
- The DB may contain repo names, branch names, and timestamps — but **not prompt text**. The
  collector reads only `usage` and metadata fields, never `message.content`. Make that a hard
  rule in code and a tested invariant.
- Everything lives under `~/.tokentab/`. `tt reset` wipes it. No telemetry-phone-home, ever.
