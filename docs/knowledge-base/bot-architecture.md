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
| `src/bot/assistant.ts` | 1098+ | `handleAssistant()` — the Haiku call with `tool_use`. 16 tools defined inline (incl. `add_to_focus_body`/`edit_focus_body`, 2026-09). Tool dispatch loop bounded to 5 iterations. |
| `src/bot/focusCallbacks.ts` | new (2026-09) | Founder Focus weekly-cycle state: Sim/Não callback handling, "porquê?" comment capture, and the "quais são os teus objetivos?" answer capture — all short-lived in-memory pending maps (telegramId → expiry), never relying on the LLM to recognize these replies. |
| `src/crons/founder-focus-cycle.ts` | new (2026-09), merged off its own fixed schedule 2026-09-16 | `runFocusCumpridoAsk`/`runFocusRollover` pair that closes each founder's weekly cycle — now called from inside `founder-meeting-balance-check.ts`/`founder-meeting-check.ts` (same "Founders Meeting" calendar trigger as the team messages) rather than a fixed Sunday-18:00/Monday-08:00 schedule. See the Cron schedule table below. |
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
| `crons/founder-meeting-check.ts` | `0 8 * * *` (every day) | no | Decides whether to fire `crons/weekly-priorities.ts` today — see the Outbound messages table, row 3. |
| `crons/weekly-priorities.ts` | not scheduled directly — called by `founder-meeting-check.ts` | no | Builds + sends the weekly priorities message (group post + per-founder DMs). Renamed from `monday-priorities.ts` 2026-09-15. |
| `crons/founder-meeting-balance-check.ts` | `0 8 * * *` (every day) | no | Decides whether to fire `crons/week-balance.ts` today — see the Outbound messages table, row 4. |
| `crons/week-balance.ts` | not scheduled directly — called by `founder-meeting-balance-check.ts` | no | Builds + sends the end-of-week balance message (group post). Renamed from `friday-balance.ts` 2026-09-15. |
| `crons/pipeline-alerts.ts` | `0 8 * * 1-5` | no | Content-calendar-needs-scheduling alerts, to Madalena + Mafalda only. Was `0 */4 * * 1-5` and all 3 founders; narrowed 2026-09-15. Used to also cover stale partner/influencer alerts (calling Claude via `draft-followup.ts` for a follow-up draft, ~$0.001/draft) — removed 2026-09-15, founder's call. |
| `crons/birthdays.ts` | `0 8 * * *` | no | Birthday reminders, today-only (was a 7-day-ahead preview until 2026-09-15). **Fixed and confirmed working in production as of 2026-09-15** (see `docs/roadmap.md` "Resolvido") — was a silent no-op (`studio_supabase.disabled`) caused by a Node 20 WebSocket-transport crash blocking real credentials from activating, plus missing NAS `.env` values; both fixed. |
| `crons/founder-focus-cycle.ts` (`runFocusCumpridoAsk`) | not scheduled directly — called by `founder-meeting-balance-check.ts` | no | Asks "cumpriste o foco?" (Sim/Não) to whoever's active-week row still has `Cumprido` empty. Tapping closes the week (see `bot/focusCallbacks.ts`). **Renamed from `runSundayAsk` and merged off its own fixed-Sunday schedule 2026-09-16** — see the Outbound messages table, row 9. |
| `crons/founder-focus-cycle.ts` (`runFocusRollover`) | not scheduled directly — called by `founder-meeting-check.ts` | no | Fallback for whoever didn't tap Sim/Não: closes the week anyway (`Cumprido` stays blank) and asks for the new week's goals directly, no re-ask. **Renamed from `runMondayReask` and merged off its own fixed-Monday schedule 2026-09-16** — see the Outbound messages table, row 10. |
| `crons/tidy-mailboxes.ts` | `0 7 * * *` | **yes** (via `bot/classify-mailbox-thread.ts`) | Fully automatic Outlook inbox tidying (archives resolved threads, forwards invoice attachments) — see [`tidy-mailboxes.md`](tidy-mailboxes.md). No Notion/Telegram involved; disabled unless `OUTLOOK_TIDY_MAILBOXES` is set. |

All crons are pure Notion + Telegram + Google Calendar except **`tidy-mailboxes`** (via `classify-mailbox-thread.ts`), which calls Claude Haiku — a tiny line item (well under $0.01/run). `pipeline-alerts` used to also call Claude (via `draft-followup.ts`, for stale-outreach follow-up drafts) until that alert type was removed 2026-09-15.

## Outbound messages: DM vs group

Every message the bot sends to a founder falls into one of two categories, and the distinction matters for review:

- **Proactive (bot-initiated, fixed destination).** A cron or an event handler decides — in code — whether the message goes to the group or to a specific founder's DM. This is a deliberate per-message design choice and the one worth auditing.
- **Reactive (mirrors the incoming chat).** Slash commands, inline-keyboard callbacks, and the assistant's tool confirmations all reply with `ctx.reply(...)` in whatever chat triggered them — DM in, DM out; group in, group out. There's no per-message DM/group decision to review here, only *whether the trigger should exist at all*.

### Proactive messages (the ones to review for add/remove)

Code-verified 2026-09-15 (see "Verification notes" below for what was actually checked and what it found).

| # | Trigger | When | Pre-send check: DB + condition | Destination | Recipient logic | Source |
|---|---|---|---|---|---|---|
| 1 | Reminder due | every 5 min | **Reminders DB.** `Enviado = false` AND `Feito = false` AND `Quando <= now`. Reads every name in `Para quem` (fixed 2026-09-15 — see notes below; used to read only the first). Marks `Enviado = true` before sending, not after. | DM | Every founder listed in the reminder's `Para quem` field | `src/crons/reminders.ts` |
| 2 | ~~Daily ranked-tasks digest~~ | — | **Removed 2026-09-15.** Was: `Backlog DB`, `Prioridade semanal = true` AND open, filtered to `owner = founder`, sent to whoever was on `"daily"` cadence per `FOUNDER_CADENCE` env. Nobody was actually on "daily" cadence in practice, and it fully duplicated #3's per-founder DM whenever someone was — removed as a whole rather than fixing the overlap. Deleted: `src/crons/daily-madalena.ts`, `src/lib/cadence.ts`, `formatDailyDM`/`rankTasks`/`trafficLight`/`TrafficLight` from `src/messages/cycle.ts`, the `FOUNDER_CADENCE` env var. | — | — | *(removed)* |
| 3 | Weekly priorities | **Changed 2026-09-15 — no longer a fixed Monday time.** Checked every morning at 08:00 (`founder-meeting-check.ts`). | **Trigger: Google Calendar.** Sends the morning after a "Founders Meeting"/"Recurring Founders Meeting" event (matched case-insensitively on title, across every calendar in `GOOGLE_CALENDAR_IDS`) is found to have ended since yesterday — that's when the founders actually set priorities/foco live. Falls back to sending on Monday only if no such event is scheduled anywhere that week; if the meeting then gets scheduled/held later that same week anyway, it sends again on purpose (fresher post-meeting content beats the fallback). **Content, once triggered:** Backlog DB (`Prioridade semanal = true` AND `Status` not in `{Feito, Cancelado}`) + Founder Focus DB (`Semana = current week number`, latest row per founder). | **Group + DM** | One combined message (priorities + Founder Focus) to the group, **and** a separate DM to each of the 3 founders with just their own tasks | `src/crons/founder-meeting-check.ts` (decides *when*) → `src/crons/weekly-priorities.ts` (builds + sends) |
| 4 | Week balance | **Changed 2026-09-15 — no longer a fixed Friday-17:00 time.** Checked every morning at 08:00 (`founder-meeting-balance-check.ts`). | **Trigger: Google Calendar.** Sends the morning *of* the "Founders Meeting"/"Recurring Founders Meeting" event (matched case-insensitively on title, same as row 3) — a recap of the closing week right before the meeting resets it. Falls back to sending on Sunday only if no such event was found scheduled anywhere that week (pairs with row 3's Monday fallback the next morning: Sunday recap → Monday reset). **Content, once triggered:** Backlog DB, three separate queries — weekly priorities (`Prioridade semanal = true` AND open), completed-since-Monday (`Prioridade semanal = true` AND `Status = Feito` AND `last_edited_time >= Monday`), overdue (`Prioridade semanal = true` AND `Deadline < today` AND not Feito/Cancelado) — + Founder Focus DB for the week. | Group | End-of-week summary (priorities, completed, overdue, focus) | `src/crons/founder-meeting-balance-check.ts` (decides *when*) → `src/crons/week-balance.ts` (builds + sends) |
| 5 | ~~Weekend brief~~ | — | **Removed 2026-09-15, founder's call.** Was: `Backlog DB` (`Prioridade semanal = true` AND open) + `Founder Focus DB` + `To Discuss DB` (pending items), always sent, 09:00 Saturday. Redundant once #3 and #4 followed the actual meeting day — those two cover "prep for the meeting" already. Deleted: `src/crons/weekend-brief.ts`, `formatWeekendBrief`/`WeekendBriefArgs`/`groupByOwner`/`indent` from `src/messages/cycle.ts`. `notion.getToDiscussPending` itself is untouched (still used by `/dashboard`, `src/bot/commands.ts:128`). | — | — | *(removed)* |
| 6 | ~~Stale partner/influencer alert (no response / no progress)~~ | — | **Removed 2026-09-15, founder's call ("it's too much").** Was: Partner DB status ∈ `{Contactado, A aguardar resposta}` and `Último contacto` > 7 days ago (no_response), or `= Em negociação` > 3 days ago (no_progress); Influencer DB `= Contactado` > 7 days or `= Em conversa` > 3 days. De-duped per `(rowId, alertType, ISO week)`. Deleted: `notion.getPartnersStale`/`getInfluencersStale`, `src/bot/draft-followup.ts` (the Claude-drafted follow-up suggestion), `formatPartnerAlert`/`formatInfluencerAlert` from `src/messages/pipeline.ts`, `PartnerRow`/`InfluencerRow`/`PartnerCategory` from `src/types.ts`. `src/crons/pipeline-alerts.ts` itself stays — it still handles row 7 below. | — | — | *(removed)* |
| 7 | Content-calendar entry needs scheduling | **Changed 2026-09-15 — was every 4h Mon–Fri, now 08:00 Mon–Fri only** (founder found the 4h cadence excessive). | **Content Calendar DB**: `Date` within the next 2 days AND `Status` ∈ `{Planned, Drafted}` (i.e. not yet `Scheduled`). De-duped per `(rowId, "content_calendar", today's date)` — now largely redundant since the cron itself only runs once/day, kept as a harmless safety net. | DM | **Changed 2026-09-15 — Madalena + Mafalda only** (was all 3 founders; Beatriz opted out). | `src/crons/pipeline-alerts.ts` |
| 8 | Birthday digest | 08:00 daily | **Studio Supabase `kenko_customers`**: every row with a non-null `date_of_birth`, filtered client-side for a birthday landing **today** (`daysAhead=0` — was 7 days, simplified 2026-09-15, founder's call: "just send a message at 8am that day, nothing else"). ✅ **Fixed 2026-09-15, confirmed working in production** (see `docs/roadmap.md` "Resolvido") — was broken by a Node 20 WebSocket-transport crash plus missing NAS `.env` credentials; both fixed, `studio_supabase.configured` now logs at boot. | Group | Silent (nothing sent) when nobody has a birthday today | `src/crons/birthdays.ts` |
| 9 | Founder Focus "cumpriste?" ask (Sim/Não) | **Changed 2026-09-16 — no longer a fixed Sunday 18:00.** Fires from inside `founder-meeting-balance-check.ts`, right after row 4's team message, whichever day that lands on. | **Founder Focus DB**: `getActiveFounderFocuses()` — every founder's current `Ativo = true` row, unconditionally (no week-number filter — see the bug this fixed, below). | DM | Whoever's active Founder Focus row is still unanswered | `src/crons/founder-focus-cycle.ts` (`runFocusCumpridoAsk`), called from `founder-meeting-balance-check.ts` |
| 10 | Founder Focus rollover (closes week + asks new goals) | **Changed 2026-09-16 — no longer a fixed Monday 08:00.** Fires from inside `founder-meeting-check.ts`, right after row 3's team message, whichever day that lands on. | **Founder Focus DB**: `Ativo = true` rows whose `Semana` is still *last* week's (i.e. nobody tapped Sim/Não) — rolls the row over (deactivate + create/activate next week) before sending. | DM | Whoever didn't tap Sim/Não yet | `src/crons/founder-focus-cycle.ts` (`runFocusRollover`), called from `founder-meeting-check.ts` |
| 11 | Tidy-mailboxes feedback-log monthly nudge | 09:00, day 1 of month | **`docs/knowledge-base/tidy-mailboxes-feedback-log.md`** (shipped into `dist/knowledge-base/` at build time — see `copy-assets.mjs`), counts `Status: **pending review**` entries. **Changed 2026-09-16**: skips sending entirely when the count is 0 (used to always send regardless); the message now states the count. | DM | Hardcoded to **Madalena only** | `src/crons/tidy-mailboxes-feedback-reminder.ts` |
| ~~12~~ | ~~Dependent task unblocked~~ | — | **Removed 2026-09-16, founder's call**, along with the whole "blocked task" concept. Was: DM to a task's owner when a prerequisite it depended on (via a `Depende de` Notion relation) got marked `Feito`. Root cause for removing rather than fixing: the only code path that could ever *create* that relation (`src/bot/dependencies.ts`, `handleSetDependency`) had been unreachable dead code since the 2026-05-06 multi-intent→assistant refactor (nothing in the new tool-based assistant ever called it) — meanwhile `Bloqueado` carried zero differentiated behavior anywhere else in the bot (identical to `To do`/`Em curso` in every query, digest, and `/dashboard`). Net effect for 4+ months: any task marked `Bloqueado` stayed stuck forever with no automatic way back, and this message realistically never fired. Confirmed 0 live tasks were actually `Bloqueado` at removal time. Deleted: `src/bot/dependencies.ts` entirely, `setTaskDependency`/`getDependentTasks` from `src/notion.ts`, `SetDependencyIntent`/`"SET_DEPENDENCY"` from `src/types.ts`, `Bloqueado` from the `Status` type and every prompt/tool description that listed it. The Notion side (the `Depende de` relation property and the `Bloqueado` select option on the Backlog DB) still needs manual removal — see the note below. | — | — | *(removed)* |
| — | Tidy-mailboxes archive/forward | 07:00 daily | **Outlook only** — see `tidy-mailboxes.md` for its own pre-archive/forward checks. | **none** | Outlook-only (archive resolved threads, forward invoices) — no Telegram message at all | `src/crons/tidy-mailboxes.ts` |

Note on #9/#10: once the DM is sent, the founder's "porquê?" explanation and "quais são os teus objetivos?" answer are captured as plain follow-up DMs in the same chat by `src/bot/focusCallbacks.ts` (`tryConsumeFocusComment`, `tryConsumeGoalsAnswer`) — not a separate proactive push. They used to be independently scheduled crons (fixed Sunday/Monday); merged 2026-09-16 into rows 3/4's triggers so the personal check-in always follows the same "Founders Meeting" calendar signal as the team message.

**Notion cleanup done (2026-09-16):** the Backlog DB's `Depende de` relation property and the `Bloqueado` option on its `Status` select field were deleted from the live database via a one-off surgical `dataSources.update()` (read the real current option list first, filtered out just `Bloqueado`, never hand-typed a replacement list — see `notion-api-gotchas.md`'s 2026-09-07 incident for why). Verified before deleting: 3 rows had real historical `Depende de` links ("enviar acordo parassocial à Maria" ×2, "ler acordo parassocial" ×1), all on already-`Feito` tasks — recorded here since that data is now gone from Notion. Verified after: property list and `Status` options match exactly what was intended, spot-checked 5 unrelated rows read back fine.

### Verification notes (2026-09-15)

Read every cron listed above plus the `src/notion.ts` query functions and `src/messages/cycle.ts` templates they feed. Core logic (filters, dedup keys, recipient lookup) is correctly wired to the DB fields it claims to read. Two issues flagged in the 2026-05-15 failure-mode audit are **already fixed** in the current code and can be crossed off: the `rowToOpenTask`/`getOpenTasks` priority-shape mismatch (now unified via `normalizePriority`, `src/notion.ts:905`) and the recurring-reminder UTC drift (`nextOccurrence` now does UTC-only arithmetic, `src/lib/recurrence.ts:3-37`).

Things found while checking that are still open, ranked by how much they'd surprise a founder:

1. ~~**Monday-morning double digest for "daily" cadence founders.**~~ **Resolved 2026-09-15 by removing message #2 entirely** (the daily digest) rather than de-duplicating it against #3 — founder's call: nobody used "daily" cadence, and they only need the Monday message. See #2's row above.
2. ~~**`formatDailyDM` silently drops some tasks.**~~ **Moot 2026-09-15** — `formatDailyDM` no longer exists (deleted along with message #2).
3. ~~**Reminders: `Para quem` is a multi-select field but only the first name is read.**~~ **Fixed 2026-09-15.** Reminders now notify every name listed in `Para quem`, not just the first (`readMultiSelectNames`, `src/notion.ts`; `ReminderRow.paraQuem` is now `FounderName[]`). No behavior change for reminders the bot itself creates (always one name per row) — this only mattered if a founder manually added a second name in Notion.
4. ~~**Reminder send isn't fully idempotent.**~~ **Fixed 2026-09-15.** `src/crons/reminders.ts` now marks `Enviado = true` *before* sending the DM(s), not after — a failed Notion write now skips the send and retries clean next tick, instead of risking a duplicate DM. Trade-off: if the write succeeds but the Telegram send itself then fails, that reminder won't auto-retry (logged as `reminders.dm_failed` for manual follow-up) — judged the better failure mode of the two.
5. ~~**No overlap guard on the 5-minute reminders cron.**~~ **Fixed 2026-09-16.** A module-level `running` flag in `src/crons/reminders.ts` makes a second `run()` call return immediately (logged as `reminders.overlap_skipped`) if a previous call is still in flight, instead of both potentially fetching and sending the same due reminder. New `test/reminders.test.ts` covers this directly (a deferred `getDueReminders` call simulates a slow first run; asserts the overlapping second call touches neither Notion nor Telegram, and the reminder still goes out exactly once).
6. **No Telegram 4096-char guard on group digests.** `week-balance` (renamed from `friday-balance`) and `weekly-priorities` (renamed from `monday-priorities`) build messages from Notion query results with only partial slicing (top 15/10 items in some sections, none in others — e.g. the per-founder priority list is unbounded). Checked against the founder's real numbers (2026-09-15): they don't run more than ~10 open tasks at a time, and 10 tasks × 3 founders comes nowhere near 4096 characters even combined in one message — **not a practical risk at current scale**, so left as-is rather than adding speculative capping. Revisit only if usage grows a lot. (`weekend-brief` had the same characteristic but was removed 2026-09-15, see row 5 above.)
7. **Fixed 2026-09-15 — DST bug in `/remind amanhã` and `/remind <dia da semana>`.** Found while checking reminders for Lisbon-timezone correctness (not from the original audit). `at9amLisbon` (`src/bot/remind.ts`) reparsed a Lisbon-formatted string as the *container's own* local time (correct only because the container's `TZ` is actually set to `Europe/Lisbon` — see `docker-compose.yml`) and then **also** subtracted the Lisbon/UTC offset on top of that — a double correction. Under the real deployment this made every DST-affected "amanhã"/weekday reminder fire **exactly one hour early during summer time** (invisible in winter, when the offset is 0). Since today is 2026-09-15 (still DST), this was live in production. Rewritten to go through the same container-TZ-independent `lisbonNaiveToUtcIso` helper (`src/lib/tz.ts`) everything else uses; also dropped the now-redundant `utcNoZ`/`lisbonOffsetMs` helpers. Regression tests added: `test/remind.test.ts` (checks both DST and winter cases; would have caught this). Plain offset forms (`/remind 2h`, `/remind 1d`, etc.) were never affected — they don't go through `at9amLisbon`.

8. **Fixed 2026-09-15 — weekly priorities silently disappeared once a task aged past the week it was created in.** Found while investigating a founder report of the daily digest always saying "nada no backlog". `getWeeklyPriorities` (`src/notion.ts`) filtered on `Prioridade semanal = true` AND status open — correct — but then ALSO required the task's `Semana` property to string-match the current week label. `Semana` is a Notion **formula**, `concat("Semana ", formatDate(prop("Criado em"), "W"))` (`scripts/setup-notion-dbs.mjs`) — it's frozen to the week the task was *created*, not "the week this priority is for", and nothing anywhere clears/resets `Prioridade semanal` between weeks (`setWeeklyPriority` is only ever called once, from the "📌 Prioridade semanal" button). Net effect: any weekly priority still open past the calendar week it was created in vanished from every consumer of `getWeeklyPriorities` — the (now-removed) daily digest, Monday's group + per-founder DMs (#3), Friday balance's "prioridades semanais" section (#4, not its completed/overdue sections — those don't check `Semana`), the weekend brief (#5), and the `/week` command. Fixed by dropping the `Semana` check entirely — the checkbox plus open status is already the correct "current weekly priorities" filter on its own. Also removed the now-unused `readFormulaString` helper. Verified: `npm run typecheck`, `npm run test` (118/118), `npm run build`, all clean. The Backlog DB's `Semana` column itself is untouched (still in Notion) — the bot just no longer reads it for this purpose.

All 8 items are now resolved (fixed, removed, or confirmed a non-issue at current scale) and verified (`npm run typecheck`, `npm run test`, `npm run build` all clean throughout).

### Reactive replies (mirror the incoming chat — not a per-message DM/group choice)

| Trigger type | Examples | Source |
|---|---|---|
| Slash commands | `/task`, `/lista`, `/dashboard`, `/projects`, `/partners`, `/events`, `/influencers`, `/calendar`, `/week`, `/focus`, `/start`, `/help` | `src/bot/commands.ts`, `src/bot/week.ts`, `src/bot/focus.ts` |
| Inline-keyboard callbacks | Task undo, mark-as-weekly-priority, edit-undo, Founder Focus Sim/Não tap | `src/bot/callbacks.ts`, `src/bot/focusCallbacks.ts` |
| Assistant tool confirmations (free text, Haiku `tool_use`) | `create_task`, `create_reminder`, `log_entry`, `log_decision`, `update_record`, `search_records`, `create_entity`, `add_to_discuss`, `set_focus`, `create_calendar_event`, `create_content_calendar_entry`, `add_to_list`, `add_to_page_section`, `add_to_focus_body`/`edit_focus_body` | `src/bot/assistant.ts` |
| Unknown-user warning | One-time "este bot só funciona para a equipa do Haven" | `src/bot/dm.ts` |

All of these call `ctx.reply(...)` (or `ctx.editMessageReplyMarkup`), which Telegram routes back to the chat the update came from — grammY never needs to be told DM vs group here, because the incoming `ctx.chat` already is that chat.

## State model

**Stateless across container restarts.** Everything important lives in Notion. The in-memory state that does exist:

| State | Where | Survives restart? | Risk |
|---|---|---|---|
| Open-tasks cache | `notion.ts` module scope | no | 60-second TTL, invalidated on writes |
| Recent message history per chat | `bot/history.ts` | no | Last 5 turns, in-memory ring |
| Last bot replies per chat | `bot/index.ts` | no | Used for "what did I just say?" context |
| Pending file uploads | `bot/index.ts:61-62` | no | 5-min TTL, abandoned on restart |
| Deduped update IDs | `bot/index.ts:91-105` | no | After restart, an update within Telegram's retention window can be reprocessed once |
| Pipeline-alerts seen-key set | `crons/pipeline-alerts.ts` | no | Prevents duplicate content-calendar alerts within the same day; resets on restart. Largely moot now the cron only runs once/day anyway (see Outbound messages table, row 7) — kept as a harmless safety net. |
| Founder Focus "porquê?" pending comment | `bot/focusCallbacks.ts` | no | 2h TTL, keyed by Telegram user id. If the bot restarts between "Não" and the comment reply, the comment is lost — `Comentários` just stays blank (fine, it's manual-fill fallback anyway) |

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

## Adjacent tooling (not part of the live pipeline)

Not every script in this repo runs inside the bot. The Outlook → Notion partnerships sync (`scripts/{outlook-auth,scan-outlook-partnerships,apply-outlook-findings}.mjs`, `.claude/skills/sync-partnerships/`) is a Claude-Code/skill-driven procedure a founder runs on demand, always with a human reviewing before any write — it deliberately isn't a cron, so it's not in the schedule table above. See [`outlook-partnerships-sync.md`](outlook-partnerships-sync.md).

**`src/lib/outlook.ts` itself is shared with `crons/tidy-mailboxes.ts`**, which *is* a real live-bot cron (see the schedule table) — it's the opposite design from the partnerships sync: fully automatic, no review step, because archiving/forwarding email is lower-stakes and more reversible than writing business records to Notion. Don't assume "Outlook" means "not part of the live bot" — check whether the specific feature is a cron or a script.

**Mafalda's Instagram/WhatsApp inbox tables** (found 2026-09-21): `public.inbox_contacts` and `public.inbox_messages`, in the same Studio Supabase project haven-va already reads `kenko_*` from — but NOT created by any haven-va migration, and not owned by this repo. They're written by Mafalda's own separate tooling: a live webhook receiver (`/api/webhooks/meta`, logged to `public.inbox_webhook_log`) plus a one-time Instagram "download your data" export backfill. `inbox_contacts.platform` is `whatsapp`|`instagram`; `kenko_customer_id` auto-matches only via `phone_digits`, so Instagram contacts (no phone) are essentially never auto-matched to a CRM customer that way — `src/crons/leads-instagram-scan.ts` does its own name-based matching instead (`src/lib/leads.ts`'s existing `checkExistingCustomer`, unchanged). `inbox_messages.source` is `webhook` (live) or `manual_upload` (the Instagram backfill). As of 2026-09-21 the Instagram webhook is confirmed live; WhatsApp's is still blocked on Meta Business Verification — haven-va only reads Instagram from these tables for now. If `leads-instagram-scan.ts`'s Monday run looks quiet, check `inbox_webhook_log` (Mafalda's side) before assuming haven-va's own code regressed — that table's health is outside this repo.

## Last touched

2026-09-21 — Added `src/crons/leads-instagram-scan.ts` (new weekly cron, Monday 08:12) to classify and match Instagram DM leads — both the historical backlog Mafalda backfilled into her own `inbox_contacts`/`inbox_messages` tables and new DMs going forward, via one checkpoint-driven mechanism (see the "Mafalda's Instagram/WhatsApp inbox tables" note above and the cron's own docstring for the dedup design). New `src/lib/instagram-inbox.ts` (Supabase fetch/grouping, transcript building, email/phone extraction, exclusion list), new `src/prompts/lead-classifier-dm.md` + `isGenuineInformationRequestDM` in `src/lib/lead-classifier.ts` (small multi-prompt refactor, `isGenuineInformationRequest`'s existing behavior untouched), new `formatLeadsDigests` (chunked) in `src/messages/leads.ts` for the historical run's potentially large first batch. CRM matching reuses `src/lib/leads.ts`'s `checkExistingCustomer` completely unchanged. Registered in `src/server.ts` but **not yet deployed** — `scripts/dry-run-instagram-leads.mjs` needs a real run reviewed with the founder first (confirms the exclusion list, spot-checks classifications) before this goes live; see that script's own usage comment. `npm run typecheck`/`test` (185/185)/`build` all clean.

2026-09-15 — **Production incident, self-contained.** Adding real `STUDIO_SUPABASE_URL`/`STUDIO_SUPABASE_KEY` to the NAS `.env` (to actually fix message #8) crashed the bot at startup: `@supabase/supabase-js`'s `createClient()` always constructs a `RealtimeClient` internally — even though this bot never subscribes to anything — and that constructor throws synchronously if it can't find a WebSocket implementation. Node only gained a native global `WebSocket` in v22; this bot runs Node 20 (`engines` in `package.json`). So `createClient` was silently never exercised in production until real credentials existed, at which point it took the whole container down. Immediate recovery: removed the two env vars, recreated the container, confirmed `bot.started` again — total downtime a few minutes. Root-cause fix: added the `ws` package and pass it as `realtime.transport` in `src/lib/studio-supabase.ts` (the standard fix for `@supabase/supabase-js` on Node <22 — the library's own thrown error message names this exact fix). Verified via `test/studio-supabase.test.ts` (constructs the client with fake-but-present credentials, confirms no throw — the crash was at construction time, before any network call, so no real Supabase access is needed to test it) and a local `node -e` smoke test. `npm run typecheck`/`test` (74/74)/`build` all clean. **Not yet redeployed to the NAS** — the fix needs to ship (rebuild + `docker compose build --no-cache` + `up -d`) before re-adding the real credentials, or the crash will repeat.

2026-09-15 — Message #8 (birthday digest) investigated after a founder report that it "isn't happening." Root cause confirmed via NAS logs (`ssh haven-nas`, `docker logs haven-va-haven-va-1`): `studio_supabase.disabled` fires at every container boot because `STUDIO_SUPABASE_URL`/`STUDIO_SUPABASE_KEY` are not set in the NAS `.env` — same story locally (`.env` and `.env.local` both lack them too). `fetchUpcomingBirthdays` has always silently returned `[]` as a result; this is a missing-credential problem, not a code bug, and I did **not** attempt to source or set real Supabase credentials myself (needs the founder to get them from the Supabase project dashboard and add them to the NAS `.env` — see `deploy-and-access.md`). Separately, simplified the message itself per founder request: `birthdays.ts` now calls `fetchUpcomingBirthdays(now, 0)` instead of `7`, and `formatBirthdayDigest` dropped the "📅 Esta semana" upcoming-week section entirely — it's just "🎂 hoje é aniversário de" or nothing. `npm run typecheck`/`test` (73/73, tests updated for the simplified format)/`build` all clean. Once credentials are added, this will start working immediately — no further code change needed.

2026-09-15 — Message #7 (content-calendar needs scheduling) narrowed per founder request: schedule changed from every 4h Mon–Fri to a single 08:00 Mon–Fri run (`src/server.ts`), and recipients changed from all 3 founders to Madalena + Mafalda only (Beatriz opted out) via a new `CONTENT_CALENDAR_RECIPIENTS` constant in `src/crons/pipeline-alerts.ts`. The per-day dedup logic is unchanged but now largely redundant since the cron itself only fires once/day. `npm run typecheck`/`test` (74/74)/`build` all clean.

2026-09-15 — Message #6 (stale partner/influencer alerts) removed entirely per founder decision ("it's too much" — one alert firing up to every 4h per stale record was too noisy). `src/crons/pipeline-alerts.ts` keeps handling message #7 (content-calendar) unchanged; only the partner/influencer half was cut. Deleted `notion.getPartnersStale`/`getInfluencersStale` (plus their now-orphaned `daysAgo` helper and day-threshold constants), the whole `src/bot/draft-followup.ts` (the Claude-drafted follow-up suggestion), `formatPartnerAlert`/`formatInfluencerAlert` (plus their `quoteDraft`/`statusOrDash` helpers) from `src/messages/pipeline.ts`, and the now-fully-unused `PartnerRow`/`InfluencerRow`/`PartnerCategory` types from `src/types.ts` (`PartnerStatus`/`InfluencerStatus` are kept — still used elsewhere, e.g. `create_entity`). `notion.getAllPartnerContacts` is untouched (used by the separate Outlook partnerships sync). `npm run typecheck`/`test` (74/74)/`build` all clean.

2026-09-15 — Message #5 (weekend brief) removed entirely per founder decision: redundant once #3 and #4 started following the actual meeting day instead of fixed calendar days — those two already cover "prep for the meeting." Deleted `src/crons/weekend-brief.ts` and its now-orphaned `formatWeekendBrief`/`WeekendBriefArgs`/`groupByOwner`/`indent` from `src/messages/cycle.ts`, removed its registration from `src/server.ts`. `notion.getToDiscussPending` is untouched (still used by `/dashboard`). `npm run typecheck`/`test` (74/74)/`build` all clean.

2026-09-15 — Message #4 (week balance) is no longer sent on a fixed Friday-17:00 schedule either. It's meant to land the morning *of* the Founders Meeting — a recap of the closing week right before priorities get reset in that meeting (message #3, which fires the morning *after* the same meeting). New `src/crons/founder-meeting-balance-check.ts` runs every morning and sends the message (via renamed `src/crons/week-balance.ts`, née `friday-balance.ts`) when a "Founders Meeting"/"Recurring Founders Meeting" event is scheduled for that day, falling back to Sunday only if none was scheduled anywhere that week — which pairs naturally with message #3's Monday fallback the next morning (Sunday recap → Monday reset). Added `test/founder-meeting-balance-check.test.ts` (6 cases). `npm run typecheck`/`test` (74 unique tests, all passing)/`build` all clean.

2026-09-15 — Message #3 (weekly priorities) is no longer sent on a fixed Monday-08:00 schedule. Founders set priorities/foco live during their "Founders Meeting"/"Recurring Founders Meeting" calendar event (usually Tuesday lunch, but moves), so the send now follows that meeting instead of the calendar day. New `src/crons/founder-meeting-check.ts` runs every morning (all 7 days) and sends the message (via renamed `src/crons/weekly-priorities.ts`, née `monday-priorities.ts`) the morning after that event is found to have ended, falling back to Monday only if no such event is scheduled anywhere that week — and will send again later in the week if the meeting ends up happening after a Monday fallback already fired (intentional, not a dedup bug). Added `src/lib/calendar.ts:listEventsInRange` (past-date-capable lookup; the existing `listEvents` only looked forward) and `src/lib/week.ts:sundayOf`. Added `test/founder-meeting-check.test.ts` (7 cases, mocking the calendar and send action). Also closed finding #6 (Telegram 4096-char cap): checked against the founder's real numbers (≤10 open tasks) — nowhere near the limit, left as-is. `npm run typecheck`/`test` (125/125)/`build` all clean.

2026-09-15 — Message #2 (daily digest) removed entirely per founder decision: deleted `src/crons/daily-madalena.ts`, `src/lib/cadence.ts`, the `FOUNDER_CADENCE` env var, and the now-orphaned `formatDailyDM`/`rankTasks`/`trafficLight`/`TrafficLight`/`LIGHT_EMOJI` exports from `src/messages/cycle.ts`. Removed its cron registration from `src/server.ts`. This also resolves the "Monday double digest" finding by elimination rather than de-duplication. `npm run typecheck`/`build` clean (no test coverage existed for the deleted code).

2026-09-15 — Message #2 review (daily digest): a founder reported the daily digest always says "nada no backlog". Root cause: `getWeeklyPriorities` required the Backlog DB's `Semana` formula (frozen at task-creation week) to match the current week, on top of the `Prioridade semanal` checkbox — so any priority still open past its creation week silently dropped out of the daily digest, Monday's messages, Friday balance's priorities section, the weekend brief, and `/week`. Removed that check in `src/notion.ts`; the checkbox + open-status filter is sufficient on its own. `npm run typecheck`/`test` (118/118)/`build` all clean.

2026-09-15 — Reminder review, round 1 (message #1 in the outbound-messages table). Fixed: send-order idempotency (mark `Enviado` before sending, not after) and multi-recipient `Para quem` handling in `src/crons/reminders.ts` + `src/notion.ts` (`ReminderRow.paraQuem` is now `FounderName[]`). Also found and fixed a live DST bug in `/remind amanhã` / `/remind <weekday>` (`src/bot/remind.ts`'s `at9amLisbon` was double-correcting the Lisbon/UTC offset, firing exactly 1 hour early every summer) — added `test/remind.test.ts` to lock it in. `npm run typecheck` clean, `npm run test` 118/118, `npm run build` clean. Two smaller reminder findings (no overlap guard on the 5-min cron; the multi-select fix has no live impact until someone manually adds a second name in Notion) left open, not yet actioned.

2026-09-15 — Code-verified the "Outbound messages" table against `src/notion.ts`, `src/lib/cadence.ts`, `src/lib/alert-dedup.ts`, `src/lib/birthdays.ts`, `src/lib/recurrence.ts` and `src/messages/cycle.ts`: added a per-message "pre-send check" column (which DB, which filter) and a Verification notes subsection. Confirmed two 2026-05-15 audit findings are already fixed (priority-shape mismatch, recurrence UTC drift); found one likely-unintentional duplicate DM (Monday "daily" cadence founders get two task digests) plus four smaller pre-existing gaps — see that subsection for details. No code changed.

2026-09-15 — Added the "Outbound messages: DM vs group" section: a full inventory of every proactive (cron/event-driven) message and its destination logic, plus the reactive same-chat-mirror rule for slash commands/callbacks/assistant replies.

2026-09-14 — Added `crons/tidy-mailboxes.ts` to the cron schedule table (real live-bot cron, unlike the sibling partnerships-sync scripts). Noted the Outlook partnerships sync as adjacent tooling (not in the live message pipeline or cron registry). Later same day: changed its cadence from hourly to daily (07:00).

2026-05-15 — Initial knowledge base seed during the cost/audit session.
