# Bot architecture

The 10-minute mental model. Everything below is current as of the master branch; cite-checked against source.

## What this bot is

A Telegram bot for **3 founders** (Madalena, Mafalda, Beatriz) of [The Haven Pilates](https://thehavenpilates.pt). Listens to the founders' group chat + DMs, interprets free-text Portuguese, writes to **Notion** (10+ databases) and **Google Calendar**, sends scheduled briefs and reminders.

Production-deployed as a single Docker container on a Synology NAS at Madalena's home. Long-polling (no webhooks). One Anthropic Haiku call per interpreted message.

## The 30-second flow

```
Telegram message
  ├── slash command (/task, /hoje, /dashboard, …)  → src/bot/commands.ts          (no LLM)
  ├── inline-keyboard callback                      → src/bot/callbacks.ts        (no LLM)
  ├── DM (private chat)                             → src/bot/dm.ts                (no LLM)
  └── group text                                    → src/bot/assistant.ts        (Haiku)
                                                         └── tool_use loop
                                                              └── src/notion.ts
                                                              └── src/lib/calendar.ts
```

**Three quarters of inbound messages never reach Claude.** Slash commands and callbacks dispatch directly to handlers. Only free-text group messages go through the assistant.

## File map (only the load-bearing ones)

| File | Lines | Role |
|---|---|---|
| `src/server.ts` | ~80 | Entry point. Registers cron schedules. Starts grammY in long-polling mode. |
| `src/bot/index.ts` | 478 | `buildBot()` — routing, founder identity check, file upload pipeline, Google OAuth intercept. |
| `src/bot/assistant.ts` | 1098 | `handleAssistant()` — the Haiku call with `tool_use`. 13 tools defined inline. Tool dispatch loop bounded to 5 iterations. |
| `src/notion.ts` | ~2400 | The single Notion wrapper. Singleton `Client`. Hardcoded property names. Open-tasks 60s cache. `withRetry` (3 attempts, 0.5/2/8s). |
| `src/types.ts` | ~315 | Every shared type. Add new DB fields here first. |
| `src/lib/founders.ts` | small | Telegram-ID → founder-name lookup. IDs in env vars. |
| `src/lib/tz.ts` | 24 | Lisbon-timezone helpers. **Has known TZ traps** — see `failure-modes-*.md`. |
| `src/lib/log.ts` | 24 | JSON-to-stdout logger. **No file output**. |
| `src/lib/recurrence.ts` | new | Pure recurrence helper. Added in PR #1. |
| `src/prompts/assistant.md` | 9.6 KB | The system prompt. Loaded at startup via `readFileSync`, passed as ephemeral-cached block. |

## Message pipeline (group chat, the LLM path)

1. **Telegram update arrives** via long-poll (`server.ts:78`). grammY hands it to `buildBot()` handlers.
2. **Dedupe** by `update_id` (`bot/index.ts:91-105`, in-memory ring buffer — lost on restart, fine for an unobserved 5-min gap).
3. **Founder check**: `isFounder(fromId)` against env-var IDs. Unknown users silently dropped (`bot/index.ts:347`).
4. **Routing**: text → `handleAssistant`; callback → `callbacks.ts`; DM → `dm.ts`.
5. **`handleAssistant` builds context**: datetime (Lisbon), recent history (`history.ts`, last 5 turns), open tasks for sender (capped TBD), content calendar rows (only if message matches calendar regex), last bot replies, available calendar names, available list names.
6. **Anthropic `messages.create`** with:
   - System prompt from `src/prompts/assistant.md` — cache-tagged
   - 13 tools (NOT cache-tagged today → big cost opportunity, see `cost-and-latency-*.md`)
   - Up to 5 tool-use iterations
7. **Tool dispatch**: each `tool_use` block routed to a `exec*` function in `assistant.ts`. Results fed back as `tool_result` for next iteration.
8. **Final text reply** via `ctx.reply`. Confirmations are typically pushed by individual tool handlers (`ctx.reply` inside the exec), not the model's final text turn.

## Cron schedule (Europe/Lisbon)

| File | Cron | Calls Claude? | Purpose |
|---|---|---|---|
| `crons/reminders.ts` | `*/5 * * * *` | no | Send due reminder DMs. Re-schedule recurring ones. |
| `crons/daily-madalena.ts` | `0 8 * * *` | no | Ranked-task DM for Madalena at 08:00. |
| `crons/monday-priorities.ts` | `0 8 * * 1` | no | Weekly priorities to the group. |
| `crons/friday-balance.ts` | `0 17 * * 5` | no | End-of-week summary. |
| `crons/weekend-brief.ts` | `0 9 * * 6` | no | Saturday morning prep. |
| `crons/pipeline-alerts.ts` | `0 */4 * * 1-5` | **yes** (via `draft-followup.ts`) | Stale-outreach alerts. ~$0.001 per draft. |

Five of six crons are pure Notion + Telegram. **`pipeline-alerts` is the only cron that costs API money** — and it's a tiny line item (~$0.01/day at most).

## State model

**Stateless across container restarts.** Everything important lives in Notion. The in-memory state that does exist:

| State | Where | Survives restart? | Risk |
|---|---|---|---|
| Open-tasks cache | `notion.ts` module scope | no | 60-second TTL, invalidated on writes |
| Recent message history per chat | `bot/history.ts` | no | Last 5 turns, in-memory ring |
| Last bot replies per chat | `bot/index.ts` | no | Used for "what did I just say?" context |
| Pending file uploads | `bot/index.ts:61-62` | no | 5-min TTL, abandoned on restart |
| Deduped update IDs | `bot/index.ts:91-105` | no | After restart, an update within Telegram's retention window can be reprocessed once |
| Pipeline-alerts seen-key set | `crons/pipeline-alerts.ts:23` | no | Prevents duplicate alerts within the same week; resets on restart |

You can `docker restart` anytime — the bot rebuilds state on next message.

## Deploy pipeline

Documented in [`docs/nas-deploy.md`](../nas-deploy.md). The one-line summary:

```bash
git pull && sudo docker compose build --no-cache && sudo docker compose up -d
```

Runs from the host (NAS shell), not inside the container. The Dockerfile copies the host's `dist/` into the image — so **`npm run build` must succeed before `docker compose build`**. If `dist/` is stale relative to `src/`, you ship old code with a green container. (See `failure-modes-*.md`, "Dockerfile gap" — and `setup-notion-dbs.mjs` is the canonical schema source).

The container reads its `.env` from `/volume1/docker/haven-va/data/.env` on the NAS (mounted at `/data` inside the container). The Google OAuth refresh token lives at `/data/google-tokens.json`.

## Founder identity

Bot's only auth: a hardcoded allowlist of Telegram IDs in env (`TELEGRAM_MADALENA_ID`, `TELEGRAM_MAFALDA_ID`, `TELEGRAM_BEATRIZ_ID`). Looked up via `src/lib/founders.ts`. Unknown users get silently ignored at `bot/index.ts:347`. **All Notion writes use the string name (`FounderName`), never the ID.**

## Logging

`src/lib/log.ts` emits structured JSON to stdout. Docker's log driver captures it. Inspect via **Container Manager → haven-va-haven-va-1 → Log tab** in DSM. No log files on disk.

Convention: `log.info("notion.thing_done", { id, ... })` — dotted label first, structured payload second. Always include the IDs needed to trace.

## Conventions

- All user-facing text in **pt-PT**.
- Timezone is always **Europe/Lisbon**. Use `src/lib/tz.ts`. (Known issues — see failure modes audit.)
- Bot responds only to known founders. Strangers get a one-time warned-ignored response, then silence.
- `dist/` is gitignored. Docker copies from `dist/` directly — always build before deploying.
- `.md` prompt files in `src/prompts/` get copied to `dist/prompts/` by `scripts/copy-assets.mjs` at build time. If you change a prompt, run `npm run build`.

## What's *not* here

- **No tests yet.** Vitest configured but no tests existed at session-1 (2026-05-15). First test added in PR #1 (recurrence validation). Pattern: `test/<topic>.test.ts`, import from `../src/...`.
- **No webhooks.** Long-polling only. Webhook mode requires HTTPS reachable from Telegram → non-trivial from Synology behind home router. Defer until needed.
- **No external monitoring.** If the bot dies silently (long-polling stops, OAuth token revoked, etc.), no alerting today.

## Last touched

2026-05-15 — Initial knowledge base seed during the cost/audit session.
