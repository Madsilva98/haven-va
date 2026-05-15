# haven-va failure-mode audit — 2026-05-15

> Scope: full read-through of `src/` (39 TypeScript files, ~8,150 LOC). Bot was healthy in production at time of audit (`haven-va-haven-va-1` up for 4h, zero errors/warnings in container logs, reminders + assistant + pipeline-alerts firing on schedule). This document catalogs failure modes that **could** trigger, not ones currently triggering.

---

## Critical (will silently break user-facing behavior)

- **`src/lib/tz.ts:14-19`** — `TZDate.from` returns a Date constructed from `toLocaleString("en-US", { timeZone: "Europe/Lisbon" })`. The string has no zone, so V8 reparses it as local time of the host. In a Docker container with `TZ=Europe/Lisbon` (current state) this works *by coincidence*; in any container with `TZ=UTC` it returns a Date offset by 0/+1h. All week-of-year math (`mondayOf`, `currentWeekLabel`, `weekOfYear`) flows through it.
  - **Fix:** use `Intl.DateTimeFormat` parts or set TZ env explicitly in Dockerfile.

- **`src/bot/assistant.ts:386-397` (`lisbonLocalToUtc`)** — Same trap. `new Date("2026-05-15T10:00")` returns local time of the host; `getUTC*` then "converts" it. Only correct if container TZ is `Europe/Lisbon`. If TZ ever drifts to UTC, every reminder and calendar event will be set 1 hour wrong (summer) / on-time (winter), silently.
  - **Fix:** parse manually with explicit Lisbon offset, or use a library.

- **`src/crons/reminders.ts:8-15` (`nextOccurrence`)** — Computes next occurrence using `Date` getters/setters in container local time, then returns a *naive* string `YYYY-MM-DDTHH:mm:ss` (no Z). It then gets written back to Notion's `Quando` (which earlier writes treat as UTC because `lisbonLocalToUtc` adds Z). So **on each recurrence, a "diária" reminder drifts by the container's UTC offset** (1h in summer). After ~24 fires a daily reminder slides 24 hours.
  - **Fix:** keep a single canonical timezone convention end-to-end; if `Quando` stores UTC-Z strings, `nextOccurrence` must add Z and use `getUTC*`.

- **`src/crons/reminders.ts:50-69`** — `markReminderSent` is called *after* `sendDM` succeeds. If `markReminderSent` throws (Notion 5xx after retries, or 409), the DM has already gone out and the reminder will be sent again on the next 5-minute cron tick. Idempotency is one-sided.
  - **Fix:** mark "sending" before send, or accept the duplicate risk explicitly with a dedup window.

- **`src/crons/reminders.ts:32-69`** — No overlap guard. The cron runs every 5 min; if Notion is slow and a previous invocation is still iterating `due`, the next invocation will fetch the same set and double-send.
  - **Fix:** a single in-process `let running = false` mutex.

- **`src/notion.ts:803`** — `getOpenTasksCache` is populated *before* `invalidateOpenTasksCache()` could clear it on concurrent writes. If a cron read is in-flight when a write completes, the cache will be filled with stale data after the invalidation. Race window is small but real, cache TTL is 60s.
  - **Fix:** invalidate by versioning, not nulling.

- **`src/notion.ts:751-806` + `136-141`** — `FIELD_TO_PROPERTY` uses Portuguese property names (`"Título"`, `"Área"`, `"Owner"`, `"Status"`, `"Prioridade"`, `"Deadline"`). If any of these are renamed in Notion UI, every read silently returns `""`/`null` (the readers swallow missing props), every write throws `validation_error`, and the bot keeps logging `notion.error` but the user sees only "erro — tenta outra vez". No fallback layer like the one added for select options.
  - **Fix:** at startup, call `client.databases.retrieve` and assert critical property names exist; fail loud. Notion CLI (`notion db get`) is a clean way to do this in a pre-deploy check.

- **`src/notion.ts:813-833` (`rowToOpenTask`)** — Reads priority as `"1. Alta" | "2. Média" | "3. Baixa"` while `getOpenTasks` at line 781 reads it as `"Alta" | "Média" | "Baixa"`. **Two different shapes for the same field in the same file.** One of these is wrong against the actual DB; everything routed through `rowToOpenTask` (weekly priorities, overdue, completed, dependents) will have `priority: null` if the DB uses bare "Alta". Likely silently degrading task rankings.
  - **Fix:** pick one canonical set, remove the other. Verify against the live Backlog DB first.

## High (will break under stress / external flakiness)

- **`src/notion.ts:72-80`** — `isRetriable` returns `true` for *any* non-`APIResponseError` (comment: "Network or unknown errors → retry once"), but `withRetry` then retries 3 times, not once. Includes `TypeError`, JSON parse errors, programmer bugs — they all get 3 attempts with 0.5/2/8s sleeps, multiplying latency before the user sees an error.
  - **Fix:** only retry on network-like errors (ECONNRESET, ETIMEDOUT, fetch aborted).

- **`src/notion.ts:72-80`** — 409 Conflict is *not* retried. Concurrent writes (e.g. user message + cron writing same page) will fail one side. Most likely on the open-tasks cache pages during morning/evening cron windows.
  - **Fix:** add 409 to the retry list.

- **`src/bot/assistant.ts:1037-1094`** — Tool-use loop with `MAX_ITERATIONS=5`. Concerns:
  1. If Claude requests a tool, executes, and requests the *same* tool again on next iteration, nothing prevents it (no dedup of identical calls). Costly under model drift.
  2. `dispatchTool` returns a string for "unknown tool" instead of throwing — Claude is invited to retry. Bounded by 5 iterations but burns tokens.
  3. Haiku occasionally returns `input` as `{}` for under-specified tools — exec functions accept `{}` silently (return "parâmetros em falta") which is fed back as tool_result, costing another iteration.
  4. No timeout/cost cap on the whole loop. A wedged Anthropic API call hangs the message handler indefinitely.
  - **Fix:** add per-call timeout (e.g. `AbortSignal.timeout(30_000)`), cap unique tool-call signatures, treat unknown-tool as fatal break.

- **`src/bot/index.ts:455-466`** — When `handleAssistant` throws, the outer catch sends `ERROR_MESSAGE` rate-limited. Good. But many things inside `handleAssistant` swallow errors (per-tool try/catch at line 1083-1088), so the outer catch rarely fires. The user can have a failing tool that says "erro a executar ação — tenta outra vez" with no further detail and no escalation.
  - **Fix:** surface the first failing tool name to the user; consider failing-fast vs. continuing the loop.

- **`src/lib/telegram.ts:23-59`** — No message-length check. Telegram rejects >4096 chars with HTTP 400. The crons (`weekend-brief`, `friday-balance`, `monday-priorities`) all build potentially long messages from unbounded Notion query results.
  - **Fix:** chunk-and-send at 4000 chars, or hard-truncate.

- **`src/lib/telegram.ts:23-59`** — Markdown errors. Cron messages use `MarkdownV2`; only `escapeMd` in `messages/cycle.ts` escapes special chars. Any title or focus text with `(`, `)`, `.`, `-`, `!`, `+`, `=` that wasn't passed through `escapeMd` gets the entire message rejected by Telegram.
  - **Fix:** pass-through wrapper that escapes every non-template fragment; add a unit test.

- **`src/lib/calendar.ts:222-229` (`listEventsToday`)** — Uses `new Date()` with `setHours(0,0,0,0)`, which is *container-local* midnight. Same TZ trap as above; with TZ=UTC it would miss the first hour of Lisbon's day in summer.

- **`src/lib/calendar.ts:86-103`** — `exchangeCodeForToken` and `saveTokens` write the refresh token to disk at `DATA_DIR/google-tokens.json`. If `DATA_DIR` isn't on a Docker volume mount, **the token is lost on every `docker compose build --no-cache`**. Currently safe (the mount exists per `docker-compose.yml:5`).
  - **Fix:** log on startup whether auth is via env-var fallback or file.

- **`src/lib/calendar.ts:105-122`** — No refresh-token-failure handling. If Google revokes the refresh_token, every cron that calls `listEventsToday` throws and is caught as a generic "calendar fetch failed". `daily-madalena` then sends a DM with `calDesc=""` (silent degradation).
  - **Fix:** on token error, log a loud `calendar.token_revoked` and surface to Madalena via DM.

- **`src/crons/daily-madalena.ts:13-38` (`buildFreeTimeDesc`)** — Constructs `workStart`/`workEnd` with `setHours` on `new Date()` — container-local. Same TZ trap.

## Medium (developer foot-guns)

- **`src/bot/index.ts:91-105`** — `dedupedUpdates` set of `update_id`s. The "evict first" using `.values().next().value` does FIFO-ish eviction but is fragile: a duplicate update with an ID already evicted will be reprocessed. After process restart, an update_id within Telegram's retention window can be reprocessed.

- **`src/bot/index.ts:61-62`** — `pendingFileByUser` map. Entries expire after 5 min but only checked *on next text from same user*; abandoned entries linger. Low-volume bot so fine, but unbounded growth in theory.

- **`src/notion.ts:1411-1412`** — `recurrence` is not validated. If someone renames the "Recorrência" select option in Notion to something not in the enum (`"diária"|"semanal"|"mensal"`), `nextOccurrence` falls through all branches and **returns the original date unchanged** — same reminder fires forever.

- **`src/crons/pipeline-alerts.ts:84`** — `seen.add(key)` is called *after* `notifyOwner` returns. If `notifyOwner` throws (it can't right now because it catches everything internally) we'd resend. Currently safe but fragile to refactor.

- **`src/notion.ts:947-973`** — `getOverdueTasks` uses `new Date().toISOString().slice(0, 10)` — UTC date string. Between Lisbon midnight and UTC midnight (only happens in summer, 23:00-00:00 Lisbon), "today" is yesterday in UTC — tasks due *today* show as overdue.

- **`src/notion.ts:1029-1033`** (`daysAgo`) — Same UTC-vs-Lisbon edge in cutoff. Cutoff dates for "stale partners" could be off by a day during the late-evening hour.

- **`src/bot/assistant.ts:872`** — `replace(/[̀-ͯ]/g, "")` — the range looks like combining diacritical marks but the literal characters in the source are a *very narrow* range, effectively a no-op. The accent-stripping in calendar name matching doesn't actually strip accents.
  - **Fix:** use `.normalize("NFD").replace(/\p{Diacritic}/gu, "")` like `src/notion.ts:1726`.

- **`src/bot/dependencies.ts:35,58`** — Hardcoded priority `"2. Média"` cast as `Priority`. Inconsistent with the rest of `assistant.ts` which uses bare `"Média"`. Same priority-shape mismatch as the Critical finding.

## Low (cosmetic / polish)

- **`src/lib/log.ts:3`** — Comment says "Writes to stdout for Railway to ingest" — code lives on Synology now. Stale.
- **`src/notion.ts:1-13`** — Header comment mentions "Bot Feedback databases" and "Master Backlog" — only Master Backlog is in the code.
- **`src/lib/telegram.ts:1-7`** — Comment claims this is for "cron endpoints" / webhook architecture; the bot runs as long-polling.
- **`src/server.ts:78-80`** — `bot.start({...})` long-polling; no error handler on the `.start()` promise. If polling dies (network blip), the bot stops silently.
  - **Fix:** wrap in retry/restart loop, or set up a healthcheck endpoint.
- **`src/bot/assistant.ts:34`** — Default model hard-coded as `claude-haiku-4-5-20251001`. With Claude model retirements, this will eventually 404.
  - **Fix:** latest-alias or env-only.
- **No global `process.on("unhandledRejection", ...)`** in `src/server.ts`. The `.catch()` on every cron at server.ts:16-58 covers crons; `bot.start()` doesn't have one.

## Notion CLI relevance

The Notion CLI ([github.com/makenotion/notion-cli](https://github.com/makenotion/notion-cli) — verify before relying) helps the top critical bucket:

- **Schema drift detection.** Wire `notion db get <id>` into a pre-deploy script that asserts the expected property names exist. Would have caught all the silent-failure cases under "Critical → schema brittleness".
- **Local schema setup.** Replaces `scripts/setup-notion-dbs.mjs`.
- **Webhook setup.** Not relevant — bot uses long-polling.

Sketch:
```bash
# scripts/check-schema.sh — runs in CI / pre-deploy
notion db get $NOTION_BACKLOG_DB_ID --json | jq -e '
  .properties.Título and .properties.Owner and .properties.Status and .properties.Prioridade
'
```

## Worth following up

- **Dead code:** `src/bot/remind.ts:253-282` (`createReminderFromIntent`) — exported but no callers. `src/notion.ts:1713` — `void readDateTime` suggests dead helper. `prompts/launch-templates.ts`, `prompts/regex-keywords.ts`, `prompts/feedback-examples.ts` — not imported anywhere. `messages/proposal.ts`, `messages/decisions.ts`, `messages/pipeline.ts` may be partial dead from the pre-Haiku pipeline.
- **State maps that grow:** `recentByChat`, `lastBotRepliesByChat`, `pendingFileByUser`, `pipeline-alerts.seen`, `dedupedUpdates`, `warnedStrangers`, `_eventsCache`, `_calsCache`, `_listNamesCache`. All small in a 3-person bot but worth keeping in mind.
- **Dockerfile gap:** copies `dist/` from the host. If `npm run build` is skipped before `docker compose build`, the *previous* `dist/` is shipped silently. Suggest moving `npm ci && npm run build` *inside* the Dockerfile.
- **Duplicate search logic:** `findRecordByTitle` vs `searchRecordsInDb` duplicate the 3-layer search ~70 lines each. Refactor risk: change one, forget the other.

---

*Generated by a focused code-audit agent on 2026-05-15. Source files read in full: `src/notion.ts`, `src/bot/assistant.ts`, `src/bot/index.ts`, `src/server.ts`, all `src/crons/*.ts`, `src/lib/*.ts`. Cross-checked findings against `dist/` build artifacts and live container logs.*
