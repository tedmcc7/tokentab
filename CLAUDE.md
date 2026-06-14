# CLAUDE.md — instructions for Claude Code

This file is read automatically by Claude Code. It defines how to build TokenTab so the work
stays consistent across sessions. Read `ARCHITECTURE.md` and `BUILD_PLAN.md` before writing code.

## What this project is

TokenTab: a **local-first** CLI + dashboard that attributes Claude Code token spend to a unit
of work — a **tab (feature tag)**, a **git branch**, or a **PR** — and prices it correctly.
The differentiator vs. existing usage tools is the *attribution axis*, not raw totals. Protect
that focus.

## Golden rules

- **Local and private by default.** No network calls in the default path. Never read or store
  `message.content` from the JSONL — only `usage` and metadata (ts, model, session, cwd,
  branch). This is a tested invariant, not a guideline.
- **Cost is derived, never invented.** Price each of the four token classes separately
  (input, output, cache_write, cache_read) from `prices.json`. Unpriced model → flag it, don't
  charge $0. Summing raw tokens is a bug.
- **Manual is truth; automation only proposes.** Tabs the user opens are authoritative. Hooks
  and intent-detection may *suggest* attribution but must never silently rename or re-attribute.
- **Idempotent ingest.** Re-running `tt ingest` must never double-count. Dedupe on
  `(session_id, line_hash)`; keep a per-file watermark.
- **Ship milestone by milestone.** Follow `BUILD_PLAN.md` order. Don't scaffold M4 UI while M1
  ingest is unproven. Each milestone ends green and demoable.

## Stack & conventions

- TypeScript, ESM, `strict: true`. Node ≥ 20. One language across CLI/server/UI.
- SQLite via `better-sqlite3`, single file at `~/.tokentab/tokentab.db`.
- CLI with `commander` or `cac`; server with `hono` or `express`; UI React + Vite + Tailwind +
  Recharts. Built web assets ship inside the npm package (offline-capable).
- Tests with `vitest`. The **ingest parser** and **pricing engine** must have real unit tests
  with fixture JSONL lines (including cache-heavy sessions). These are where subtle bugs live.
- Keep modules small: `src/core/{ingest,store,pricing,attribution}`, `src/cli`, `src/server`,
  `web/`.

## Definition of done (every PR)

- `npm test` and `npm run lint` pass.
- New behavior has tests; the parser/pricing invariants above still hold.
- No prompt content is read or persisted anywhere.
- User-facing CLI output shows **both tokens and dollars**.
- README/ARCHITECTURE updated if behavior or schema changed.

## Things to verify, not assume

The exact Claude Code log schema and OTel metric names can drift between versions. Before
relying on a field, confirm it against a real local JSONL file under `~/.claude/projects/` and
against current Claude Code docs. Known fields to expect on usage lines: `timestamp`, `message.usage.{input_tokens,output_tokens,cache_creation_input_tokens,cache_read_input_tokens}`,
`message.model`, `sessionId`, `cwd`, `gitBranch`. If a field is missing, degrade gracefully
(e.g., no branch → attribute to repo/session) rather than crashing.

## Guardrails (don't do these without asking the user)

- Editing the user's Claude Code settings outside the explicit `tt hooks install` flow.
- Adding any network/telemetry call in the default path.
- Hard-deleting the user's data (`tt reset` must confirm).
- Hardcoding model prices in code instead of `prices.json`.
- Pulling in heavy frameworks (Next.js, an ORM, a state library) — keep the dependency
  footprint small and contributor-friendly.

## Pricing data

`prices.json` is the single source of truth for rates. Seed rows are marked
`"verify_before_trusting": true`. When adding a model, add a price row with an
`effective_date`; do not delete old rows (historical events must keep historical cost). Treat
updating prices as a routine, well-labeled `good first issue`.
