# haven-va knowledge base

Durable notes on **how this bot works, where it breaks, how to operate it, and why.** Written for the next session (yours, Madalena's, or some future contributor's). The codebase tells you *what* the bot does; this directory tells you *what to watch out for*.

## Why this exists

Three problems this folder solves:

1. **Knowledge evaporates between sessions.** Every Claude Code session starts cold. If we learn a gotcha and don't write it down, we relearn it next time. Multiply across both founders → wasted hours.
2. **The codebase doesn't explain itself.** `notion.ts` is 2,400 lines of `client.databases.query`. The reasons behind the shape (why a 60-second cache, why retry on 429 but not 409, why we hardcode Portuguese property names) live in nobody's head once a few weeks pass.
3. **Audit findings should outlive a single PR.** The failure-mode catalog and cost-and-latency research were generated on 2026-05-15. Without a home, they'd get lost. Here they become a baseline future audits diff against.

## How to use it

**Reading**: start with `bot-architecture.md` for the mental model, then jump to whichever section matches what you're doing.

**Writing**: when you finish a session and you learned something that wasn't already here, **append it**. Each file has a "When to update" footer that lists trigger conditions. The goal is forward-compatibility — past-you should be helping future-you.

**Reviewing**: every dated audit (`failure-modes-YYYY-MM-DD.md`, `cost-and-latency-YYYY-MM-DD.md`) is a point-in-time snapshot. They're cumulative, not replaced — next audit goes in a new file so you can diff against the older one.

## Contents

| File | What it covers | When to update |
|---|---|---|
| [`bot-architecture.md`](bot-architecture.md) | Message flow, file layout, state model, deploy pipeline | When a new top-level module is added or message routing changes |
| [`deploy-and-access.md`](deploy-and-access.md) | NAS access (Tailscale, DSM, admin vs non-admin), deploy command, Container Manager, rollback | When access paths change or you discover a new "I couldn't reach X" gotcha |
| [`notion-api-gotchas.md`](notion-api-gotchas.md) | Notion data model (databases vs data sources), property type quirks, rate limits, retry strategy, deprecations | When Notion releases a new API version, you hit a 4xx error worth remembering, or a schema migration is needed |
| [`failure-modes-2026-05-15.md`](failure-modes-2026-05-15.md) | Catalog of 30+ failure modes ranked Critical → Low | Frozen — start a new dated file when you do the next audit |
| [`cost-and-latency-2026-05-15.md`](cost-and-latency-2026-05-15.md) | Anthropic + Notion cost baseline, optimization ROI table | Frozen — start a new dated file when costs grow or pricing changes |

## Related docs (outside this folder)

- [`docs/nas-deploy.md`](../nas-deploy.md) — Step-by-step deployment runbook for the NAS (in pt-PT)
- [`docs/guia-haven-va.md`](../guia-haven-va.md) — End-user guide for the founders (pt-PT)
- [`CLAUDE.md`](../../CLAUDE.md) — Quick reference for Claude Code sessions
- [`scripts/setup-notion-dbs.mjs`](../../scripts/setup-notion-dbs.mjs) — Canonical source of Notion DB schema

## Conventions for this folder

- **Date-stamped audits** (`failure-modes-YYYY-MM-DD.md`): frozen point-in-time. Never edit; supersede with a new file.
- **Topic docs** (`bot-architecture.md`, `notion-api-gotchas.md`, `deploy-and-access.md`): living. Edit freely. Keep a "Last touched" line at the bottom.
- **Cite file:line** for every claim that points at source code. Citations rot when code moves, but they make rot detectable.
- **Don't paste secrets.** Even temporarily. If a screenshot or paste exposes a token, rotate the token and note the incident.
