# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Knowledge base (read this if you haven't worked on the bot in a while)

The `docs/knowledge-base/` folder is the durable memory of "how this bot actually works, where it breaks, how to operate it." Start with [`docs/knowledge-base/README.md`](docs/knowledge-base/README.md). Skim the relevant topic doc before touching the area you're about to change:

- [`bot-architecture.md`](docs/knowledge-base/bot-architecture.md) — 10-minute mental model: message flow, file map, cron schedule, state model
- [`deploy-and-access.md`](docs/knowledge-base/deploy-and-access.md) — NAS access (Tailscale, DSM, Container Manager), deploy pipeline, rollback, secret hygiene
- [`notion-api-gotchas.md`](docs/knowledge-base/notion-api-gotchas.md) — data sources vs databases, schema brittleness, retry strategy, property type quirks
- [`outlook-partnerships-sync.md`](docs/knowledge-base/outlook-partnerships-sync.md) — Outlook → Notion Partner Pipeline sync (adjacent tooling, not the live bot): Azure setup, gotchas, checkpoint mechanism
- [`tidy-mailboxes.md`](docs/knowledge-base/tidy-mailboxes.md) — fully automatic Outlook inbox tidying cron (archive resolved threads, forward invoices) — this one IS a live-bot cron, unlike the sync above
- [`failure-modes-YYYY-MM-DD.md`](docs/knowledge-base/) — point-in-time failure-mode audits (cumulative; one per audit run)
- [`cost-and-latency-YYYY-MM-DD.md`](docs/knowledge-base/) — Anthropic + Notion cost baselines and optimization ROI

**Append to the knowledge base as you learn things.** If a gotcha bit you, write it down so it doesn't bite the next session.

## Commands

```bash
npm run build       # tsc + copy-assets.mjs (copies .md prompts to dist/)
npm run typecheck   # tsc --noEmit
npm run test        # vitest run (single pass)
npm run test:watch  # vitest (watch mode)
npm run dev         # node --watch dist/server.js (requires prior build)
```

Deploy (NAS Synology 192.168.1.11):
```bash
git pull && npm run build && sudo docker compose build --no-cache && sudo docker compose up -d
```
Note: `Dockerfile` only does `COPY dist/ ./dist/` — it does not run the build itself. Skipping `npm run build` ships whatever `dist/` was already on disk, silently. Compose uses `build: .` without `image:`, so the image is named `haven-va-haven-va` — always use `docker compose build`, never `docker build -t haven-va .`.

Setup scripts (one-shot, idempotent):
```bash
node scripts/setup-notion-dbs.mjs   # adds schema to Notion DBs
node scripts/gen-notion-config.mjs  # regenerates docs/notion-db-config.xlsx
```

## Architecture

### Entry point

`src/server.ts` — registers all cron schedules and starts the grammY bot. Nothing else lives here.

### Message pipeline

```
Telegram message
  ├── slash command → src/bot/commands.ts (handleTask, handleHoje, handleDashboard, …)
  ├── inline callback → src/bot/callbacks.ts + week/todiscuss handlers
  ├── DM (private chat) → src/bot/dm.ts
  └── group text → src/bot/assistant.ts (handleAssistant)
                      └── Claude Haiku call with tool_use
                            └── tools execute → src/notion.ts
```

`src/bot/index.ts` (`buildBot`) owns the routing logic and registers all handlers. It also handles file uploads (documents/photos → Notion page attachment) and Google Calendar OAuth intercept.

### Assistant (`src/bot/assistant.ts`)

Single Claude Haiku call per group message with `tool_choice: "auto"`. Tools defined inline: `create_task`, `create_reminder`, `log_entry`, `log_decision`, `update_record`, `search_records`, `create_entity`, `add_to_discuss`, `set_focus`, `create_calendar_event`, `create_content_calendar_entry`, `add_to_list`, `add_to_page_section`. The system prompt is loaded from `src/prompts/assistant.md` at startup via `readFileSync` and passed as an ephemeral-cached block.

Context injected into every user message: current datetime (Lisbon TZ), sender's open tasks from Notion, recent conversation history (`src/bot/history.ts`), content calendar rows (only when message matches calendar keywords), last bot replies.

### Notion wrapper (`src/notion.ts`)

Single file, ~2400 lines. Singleton `client`. All writes use `withRetry` (3 attempts: 0.5s → 2s → 8s on 429/5xx). Open tasks cached 60s; invalidated after any write. Rich-text helpers (`richText`, `readPlainText`, etc.) at the top — use these everywhere, never construct Notion blocks inline.

**Critical:** Notion property names in code must match the actual database exactly. The API returns `validation_error` with the property name if wrong — check `notion.ts` read operations (e.g., `props["X"]`) to confirm the real name before changing any write. The Notion API calls `rich_text` what Notion's UI calls "text" — they are the same type.

### Crons (`src/crons/`)

| File | Schedule | What |
|---|---|---|
| `reminders.ts` | every 5 min | Fetches due reminders from Notion, sends via Telegram |
| `founder-meeting-check.ts` | 08:00 daily | Sends `weekly-priorities.ts`'s message the morning after the "Founders Meeting" calendar event, falling back to Monday if none is scheduled that week |
| `weekly-priorities.ts` | (called by `founder-meeting-check.ts`, not scheduled directly) | Builds and sends the weekly priorities message (group + per-founder DMs) |
| `founder-meeting-balance-check.ts` | 08:00 daily | Sends `week-balance.ts`'s message the morning OF the "Founders Meeting" calendar event, falling back to Sunday if none is scheduled that week |
| `week-balance.ts` | (called by `founder-meeting-balance-check.ts`, not scheduled directly) | Builds and sends the end-of-week balance message (group) |
| `pipeline-alerts.ts` | 08:00 Mon–Fri | Content-calendar-needs-scheduling alerts, to Madalena + Mafalda only (Beatriz opted out). Was every 4h and all 3 founders; narrowed to once/morning 2026-09-15. Used to also cover stale partner/influencer pipeline alerts — removed 2026-09-15, founder's call ("too much"). |
| `birthdays.ts` | 08:00 daily | Posts to the group if any Studio Supabase `kenko_customers` row has a birthday **today** (simplified from a 7-day-ahead preview 2026-09-15). `STUDIO_SUPABASE_URL`/`STUDIO_SUPABASE_KEY` **are now configured in production** (fixed 2026-09-15, see `docs/roadmap.md` "Resolvido" — a Node 20 WebSocket-transport crash was blocking activation, now confirmed working). If you see `studio_supabase.disabled` in NAS logs, that's a regression, not expected state. |
| `tidy-mailboxes.ts` | 07:00 daily | Fully automatic Outlook inbox tidying (archive/forward) — disabled unless `OUTLOOK_TIDY_MAILBOXES` is set |
| `leads-email-scan.ts` | 08:15 Mon | Scans `OUTLOOK_MAILBOXES` for genuine information-request emails since the last checkpoint (`data/leads-email-sync-state.json`), classifies with Haiku, skips anyone who already purchased (`src/lib/leads.ts` checks `kenko_payments`+`kenko_sale_items`), writes non-customers to the Notion "Leads a contactar" DB, digest to the group. Silently no-ops without `NOTION_LEADS_DB_ID` or Outlook auth. |
| `leads-intro-pack.ts` | 08:20 Mon | Flags people whose intro pack (2 Classes / 10-Day Unlimited) ended 21+ days ago with no conversion since (`src/lib/intro-pack-conversion.ts`) — the day-21 threshold and "no pack-type split needed" were both empirically validated, not assumed. Writes into the same "Leads a contactar" DB, `Canal = "Intro Pack"`. Depends on Studio Supabase (configured in production, see the `birthdays.ts` note above). |
| `churn-risk.ts` | 08:45 Mon | 3 empirically validated signals against Studio Supabase (no booking 21+ days / failed payment in 45 days / <50% plan utilization in each of the last 3 full months) — see `src/lib/churn-signals.ts` for why the "obvious" signals (no-show rate, unused credits, days-since-cancellation) were tested and rejected. Writes/updates the Notion "Clientes em risco" DB, digest only for what's new/changed this week. Depends on Studio Supabase (configured in production, see the `birthdays.ts` note above). |

### Types (`src/types.ts`)

All shared types live here: `FounderName`, `Area`, `Priority`, `Status`, all row interfaces (`ReminderRow`, `ToDiscussRow`, `PartnerRow`, etc.), all intent types. When adding a new Notion DB or field, add the type here first.

### Founder identity

Founders identified by Telegram user ID → name via `src/lib/founders.ts`. IDs come from env vars `TELEGRAM_MADALENA_ID`, `TELEGRAM_MAFALDA_ID`, `TELEGRAM_BEATRIZ_ID`. All Notion writes use the string name (`FounderName`), never the ID.

## Key conventions

- All user-facing text in pt-PT.
- Logs use structured JSON via `src/lib/log.ts` (`log.info`, `log.warn`, `log.error`), always with a dotted label and a data object: `log.info("notion.thing_done", { id })`.
- Timezone is always `Europe/Lisbon`. Use `src/lib/tz.ts` for conversions.
- The bot only responds to known founders (checked via `isFounder(fromId)`). Unknown users are silently ignored.
- `dist/` is gitignored. Docker copies from `dist/` directly — always build before deploying.
- `.md` prompt files (`src/prompts/`) are copied to `dist/prompts/` by `scripts/copy-assets.mjs` at build time.

## Environment variables

See `.env.example`. Notion DB IDs are all optional except `NOTION_BACKLOG_DB_ID` — missing IDs disable the corresponding feature gracefully.
