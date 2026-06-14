# TokenTab

> Run a tab on your AI spend — per feature, per branch, per PR.

**TokenTab** turns the raw token logs Claude Code already writes on your machine into a
spend ledger you can actually reason about: *"the new settings button cost me $0.42 and
38 minutes of model time."* It's a one-command local dashboard plus a tiny CLI, and it
attributes every token to a **unit of work you care about** — a feature tag, a git branch,
or a pull request — not just a faceless daily total.

```bash
npx tokentab            # opens the local dashboard
tt start "new button"   # open a tab; everything you build now bills to it
tt stop                 # close it — see what it cost
```

---

## Why this exists

For 500 years business ran on two kinds of spend: **people** and **vendors**. A third just
arrived — **intelligence, paid by the token** — and it's invisible to almost every tool we
use to manage cost. Finance teams are racing to put a meter on it. Individual developers
have nothing.

If you code with Claude Code all day, you are already running a small AI budget. You just
can't see it the way you'd see a cloud bill. You don't know whether the feature you shipped
cost 5 cents or 5 dollars, whether your test-fixing loops are quietly the most expensive
thing you do, or which branch burned the most tokens this week.

TokenTab is the meter — but pointed at *your* workflow, at the granularity of the work
itself. Open a tab, build, close it, and see the cost attributed to that feature. It's a
personal, local, open-source take on what spend-management platforms are now doing at the
company level: **attributing token spend to a unit of business value.**

## What makes it different

There are already good tools that read Claude Code's local logs and total your usage by
day, session, or model — [ccusage](https://github.com/ryoppippi/ccusage),
[claude-usage](https://github.com/phuryn/claude-usage), and OpenTelemetry exporters like
[claude_telemetry](https://github.com/TechNickAI/claude_telemetry) and
[claude-code-otel](https://github.com/ColeMurray/claude-code-otel). They answer *"how much
did I spend today?"*

TokenTab answers a different question: **"what did building *this* cost?"**

| | Existing usage trackers | **TokenTab** |
|---|---|---|
| Primary unit | Day / session / model | **Feature tag / branch / PR** |
| Mental model | "My monthly bill" | "My tab per thing I built" |
| Workflow tie-in | Passive read of logs | `tt start`/`tt stop`, git-aware, hook-driven |
| Output | Usage totals | **Cost attribution** + per-feature ROI view |
| Automation | — | Auto-tag by branch; auto-open tabs via hooks |

Same data source, different axis. That axis is the whole point.

## How it works (in one breath)

Claude Code writes a JSONL transcript per session to `~/.claude/projects/...`, and every
model-call line carries a `message.usage` block (input, output, and cache tokens) plus a
timestamp, working directory, and git branch. TokenTab **ingests** those lines into its own
local SQLite store (so they survive log rotation), **prices** each token class correctly
(cache reads are cheap, cache writes are not — naive summing is how people get costs 100×
wrong), and **attributes** each call to whichever tab/branch was active at that moment. A
small local server renders the dashboard.

Nothing leaves your machine. No API keys required for the default mode.

## Quickstart

```bash
# Run the dashboard (ingests your existing logs on first run)
npx tokentab

# Or install the CLI
npm install -g tokentab

tt start "checkout redesign"   # open a named tab
# ... build with Claude Code as usual ...
tt stop                        # close it and print the cost
tt ls                          # list recent tabs and what they cost
tt today                       # today's spend, grouped by tab
```

Prefer zero ceremony? Skip `tt start` entirely — TokenTab auto-attributes by git branch, so
you get per-branch (and, with the `gh` CLI, per-PR) costs for free.

## Status

Early and local-first. See [`BUILD_PLAN.md`](./BUILD_PLAN.md) for the roadmap and
[`ARCHITECTURE.md`](./ARCHITECTURE.md) for how the pieces fit. Contributions welcome —
the data model is small and the surface area is friendly.

## Name

Working name is **TokenTab** (CLI `tt`). Other candidates if you want to bikeshed:
*Toll*, *Meter*, *Tollbooth*, *vibecost*, *TokenLedger*. Pick one before first publish — it's
the one thing that's annoying to change later.

## License

MIT.
