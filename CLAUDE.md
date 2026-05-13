# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

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
git pull && sudo docker build -t haven-va . && docker compose up -d
```

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
| `daily-madalena.ts` | 08:00 daily | Daily digest for Madalena |
| `monday-priorities.ts` | 08:00 Monday | Weekly priorities message |
| `friday-balance.ts` | 17:00 Friday | End-of-week summary |
| `weekend-brief.ts` | 09:00 Saturday | Weekend brief |
| `pipeline-alerts.ts` | every 4h Mon–Fri | Stale partner/influencer pipeline alerts |

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

See `.env.example`. Notion DB IDs are all optional except `NOTION_BACKLOG_DB_ID` — missing IDs disable the corresponding feature gracefully. `FOUNDER_CADENCE` is a JSON object controlling cron frequency per founder.
