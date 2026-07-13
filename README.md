# haven-va

Telegram bot for the founders of [The Haven Pilates](https://thehavenpilates.pt) (Carcavelos, PT). Listens to the founders' group chat, interprets free-text Portuguese, writes to Notion + Google Calendar, and sends scheduled briefs and reminders.

## What it does

- **Conversational Notion writes.** *"cria task para a Beatriz: rever proposta WellHub"* → task created in the right Notion DB with the right owner/area/priority. No commands, no forms — just talk like to a colleague.
- **Reminders.** *"lembra-me amanhã às 10h de testar"*, *"todos os anos no aniversário da empresa"*, *"avisa todas hoje às 23h59"*. One-shot, daily, weekly, monthly, annual.
- **Daily birthday digest** at 08:00 — queries the Studio Supabase for customer birthdays today + next 7 days.
- **Scheduled briefs** — daily-for-Madalena, Monday priorities, Friday end-of-week, Saturday weekend prep, every-4h pipeline alerts.
- **Entity tracking** — partners, projects, events, influencers each have their own Notion DB with structured fields.

## Stack

- Node 20 + TypeScript + [grammY](https://grammy.dev) (Telegram client)
- [@notionhq/client](https://github.com/makenotion/notion-sdk-js) v5+ (data-sources API, 2025-09-03)
- [@anthropic-ai/sdk](https://github.com/anthropics/anthropic-sdk-typescript) for Claude Haiku tool-use (prompts in `src/prompts/`)
- [@supabase/supabase-js](https://github.com/supabase/supabase-js) for the customer-birthday cron
- [node-cron](https://github.com/node-cron/node-cron) for in-process scheduling
- Docker on a Synology NAS at Madalena's home (long-polling, no public endpoint)

## Quickstart

```bash
# Once
npm install
cp .env.example .env   # fill in the values

# Dev
npm run typecheck      # tsc --noEmit
npm run test           # vitest run
npm run build          # tsc + copy-assets.mjs (copies prompts to dist/)
npm run dev            # node --watch dist/server.js — runs the bot locally
```

The bot only responds to known founders (identified by Telegram user ID via `TELEGRAM_*_ID` env vars). Everyone else is silently ignored.

## Deploy

Runs as a Docker container on the NAS. Standard deploy from a NAS shell:

```bash
cd /volume1/docker/haven-va/code/haven-va
git pull
sudo docker compose build --no-cache
sudo docker compose up -d
```

Watch the startup logs (Container Manager → `haven-va-haven-va-1` → Log tab) for:
- `notion.data_source_resolve_done` ×11 — multi-source canary passed
- `studio_supabase.configured` — birthday cron ready
- `server.crons_registered` — node-cron schedules live
- `bot.started` — long-poll up

If anything else appears at startup → rollback is `git checkout <previous-sha> && rebuild`.

See [`docs/knowledge-base/deploy-and-access.md`](docs/knowledge-base/deploy-and-access.md) for the full runbook (Tailscale, DSM, Container Manager, secret hygiene).

## Architecture

In short:
- `src/server.ts` — entry point, registers crons + starts the bot
- `src/bot/index.ts` — message routing
- `src/bot/assistant.ts` — Haiku call with tool-use (13 tools)
- `src/notion.ts` — Notion wrapper, ~2400 lines, the single source of DB access
- `src/crons/` — 7 scheduled tasks (reminders every 5 min, daily-madalena, monday/friday/saturday weekly cycles, pipeline alerts, birthdays)
- `src/prompts/assistant.md` — system prompt (cached at the Anthropic prompt-cache tier)

For the full mental model, read [`docs/knowledge-base/bot-architecture.md`](docs/knowledge-base/bot-architecture.md).

## Knowledge base

`docs/knowledge-base/` is the durable home for everything not derivable from the code:

| Doc | What |
|---|---|
| [`bot-architecture.md`](docs/knowledge-base/bot-architecture.md) | Mental model, file map, state, deploy pipeline |
| [`deploy-and-access.md`](docs/knowledge-base/deploy-and-access.md) | NAS access, deploy command, rollback, secret hygiene |
| [`notion-api-gotchas.md`](docs/knowledge-base/notion-api-gotchas.md) | Notion data model, schema brittleness, retry strategy, rate limits |
| [`failure-modes-YYYY-MM-DD.md`](docs/knowledge-base/) | Point-in-time failure-mode audits (cumulative — new file per audit) |
| [`cost-and-latency-YYYY-MM-DD.md`](docs/knowledge-base/) | Anthropic + Notion cost baselines and ROI ranking |

If a session teaches you something not already in there, **append it.**

## Project conventions

- All user-facing text in **pt-PT**.
- Timezone is always **Europe/Lisbon**. Use `src/lib/tz.ts` (and read the failure-modes doc — there are known TZ traps).
- Logs use `src/lib/log.ts` (structured JSON to stdout, captured by Docker). No log files on disk.
- All Notion writes go through `src/notion.ts` — never construct Notion blocks inline. Use the rich-text helpers at the top of the file.
- **Atomic commits, conventional format.** `feat(scope): …`, `fix(scope): …`, `build:`, `docs:`. One logical change per commit.
- Tests live in `test/*.test.ts`. Vitest. Run with `npm run test`.

## Contributors

- **Madalena** ([@Madsilva98](https://github.com/Madsilva98)) — maintainer, runs the NAS, owns the deploy
- **Mafalda** ([@mssaudade](https://github.com/mssaudade)) — write access, focus on tests + Notion API resilience

## Repo & related

- This repo: [`Madsilva98/haven-va`](https://github.com/Madsilva98/haven-va)
- The Haven website: [thehavenpilates.pt](https://thehavenpilates.pt)
- Studio dashboard (separate): [`mssaudade/haven`](https://github.com/mssaudade/haven)
