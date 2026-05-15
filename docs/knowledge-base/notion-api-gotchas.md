# Notion API gotchas

The shape of "things that bit us" or "things the docs warn us about, that we forget." This file is **partially seeded** — a thorough survey of developers.notion.com is in progress (research agent dispatched 2026-05-15) and will populate the rest.

## TL;DR for the next session

1. **Notion changed its data model.** Databases now contain **data sources**, each with their own schema. The bot still uses the older `databases.query()` endpoint — currently works because each DB has one data source, but is on a deprecation path. ([Notion docs: working with databases](https://developers.notion.com/guides/data-apis/working-with-databases#structure))
2. **Schema names are hardcoded.** Every Notion property name used by the bot (`Título`, `Owner`, `Status`, `Prioridade`, etc.) is a string literal in `src/notion.ts`. A rename in Notion's UI silently breaks reads (return `null`) and writes (throw `validation_error`). See `failure-modes-2026-05-15.md` "Critical → schema brittleness".
3. **The Notion API calls `rich_text` what Notion's UI calls "text"** — they are the same type. Forgetting this trips you up when you compare `setup-notion-dbs.mjs` against the Notion UI.
4. **`withRetry` retries 429 and 5xx, NOT 409.** Concurrent writes to the same page (cron + user message) will fail one side. See `src/notion.ts:72-80`.
5. **The retry budget is 3 attempts at 0.5s/2s/8s.** Roughly aligned with Notion's documented rate-limit guidance, but verify against [the rate limits doc](https://developers.notion.com/reference/request-limits) — pending the deep-research output.

## The data model shift (2026-ish)

Before: a Notion database had a `properties` map directly. You called `databases.retrieve(<db_id>)` and got the schema in the response.

Now: a database has a `data_sources` array. Each data source has its own `properties`. To get the schema:

```
1. client.databases.retrieve({ database_id })     → get the data_sources[] array
2. client.dataSources.retrieve({ id: <ds_id> })   → get that data source's properties
```

The bot today does step 1 implicitly via `databases.query()` (the older endpoint). Notion's docs describe this as the "older API surface" and recommend the data-sources flow for new connections. Whether `databases.query()` is officially deprecated vs. just-discouraged is **pending verification** in the deep-research output.

### What this means for the bot's queries

- `client.databases.query({ database_id, filter, … })` — current pattern, still works for single-data-source DBs (which is what we have).
- `client.dataSources.query({ data_source_id, filter, … })` — the new pattern; requires resolving `data_source_id` first.
- The **filter and sort objects look identical** between the two endpoints, so migrating reads should be mechanical once the data source ID is cached.

**No action required today.** Flagged here so the next person who refactors `notion.ts` knows.

### What it means for the schema-drift check (planned PR #5)

The original design (a pre-deploy script that compares expected property names to live names) needs to call `dataSources.retrieve`, not `databases.retrieve`, to get the actual property schema. The high-level shape of the check is unchanged.

## Hardcoded property names — the silent-failure surface

`src/notion.ts` reads `props["X"]` everywhere. If "X" doesn't exist on the row, `readPlainText(undefined)` returns `""`, `readSelectName(undefined)` returns `null`, etc. **Reads degrade silently** — every task suddenly has `priority: null`, every reminder has `recurrence: undefined`. Writes throw `APIResponseError` with `validation_error` and `withRetry` will swallow + log, leaving the user with "erro a executar ação — tenta outra vez" and no further detail.

**Defense**: PR #5 plans a `scripts/check-schema.mjs` that uses `@notionhq/client` directly (not the Notion CLI — the official CLI has no `db schema` subcommand) to assert every property name the bot uses still exists in each live DB. Runs before `docker compose up -d`. Blocks the deploy on drift.

**Canonical schema source**: `scripts/setup-notion-dbs.mjs` already declares the expected schema per DB. The plan is to extract this into a shared `scripts/expected-schema.mjs` that both the setup script and the new check script consume.

## Status field vs Select field

Notion has two visually-similar field types:
- **Select** — a single-choice tag. Read via `readSelectName(prop)` → `string | null`.
- **Status** — a single-choice tag with predefined transitions. Read via `readStatusName(prop)` → `string | null`. Sometimes Notion returns Status props through the same code path as Select — `src/notion.ts:700` does the fallback dance:

```ts
readStatusName(row.properties[prop]) ?? readSelectName(row.properties[prop]) ?? undefined
```

Madalena migrated several fields from Select → Status in May 2026 (commit `feat: migrate Status fields to Notion status type + remove Studio Log`, 2026-05-14). Both read paths exist for backwards-compat. When adding a new status-like field, prefer Status type from the start.

## Rich-text vs plain-text

A `title` property and a `rich_text` property both contain an array of formatted spans. Use `readPlainText(prop)` to coalesce to a string. **Never construct Notion blocks inline** — use `richText(string)` from the top of `notion.ts` to build the right shape.

## The `Recorrência` field — recently hardened

Was: any string from the Notion select silently became a `ReminderRecurrence` and the `nextOccurrence` switch fell through silently → reminder fired forever.

Now (PR #1 on `fix/recurrence-validation`, 2026-05-15): literal-union type + `isValidRecurrence` type guard, validated at both the Notion read site and the LLM tool input site. `nextOccurrence` throws on unknown values rather than re-scheduling at the original date.

Open question for future Notion docs review: does Notion's Date property support **native recurrence** that the bot could use instead of re-creating reminders each fire? (Spoiler: no — the "remind me" feature on a date is just a notification, not a date-changes-itself trigger. The bot's recurrence logic stays necessary.)

## Rate limits and concurrency

- **Documented limit** (pending verification from deep-research output): roughly 3 requests/sec sustained, with bursts allowed.
- **Retry strategy in code** (`src/notion.ts:72-80`): 3 attempts, 0.5/2/8s exponential, **only on 429 and 5xx**.
- **Not retried**: 409 Conflict (concurrent writes), 4xx other than 429. The bot lets one side of a concurrent write fail silently — likely never seen in production at 3-founder traffic, but a real risk under bursty cron windows.

When the deep-research output arrives, update this section with the precise rate-limit numbers and Notion's recommended backoff curve. Diff against current `withRetry`.

## File uploads

The bot accepts Telegram photo and document messages. The flow in `bot/index.ts`:

1. Telegram delivers a `Message` with `photo[]` or `document`.
2. Bot stores the file metadata in `pendingFileByUser` (in-memory, 5-min TTL).
3. On the next text message from the same user, attach the file URL to whatever Notion entity the assistant decides on.

Open question for future research: does Notion's **File Upload API** (introduced 2025-ish) replace this URL-based attachment with a direct upload to Notion's CDN? Could be cleaner.

## Comments API

The bot does not currently read or write Notion comments. Could be a smart future feature ("the bot adds a comment on the task page when it marks it done, linking back to the Telegram message"). Pending API survey.

## Webhooks

The bot does not currently consume Notion webhooks. Schema-change events would be the killer use case — drift-detect via subscription instead of pre-deploy polling. Pending verification of what Notion's webhooks actually support (research agent will fill this in).

## Documented Notion warnings (from the docs the agent has read so far)

- **Linked databases** (Notion's UI feature where one DB displays rows from another) are **not supported by the public API**. The integration must be granted access to the original data source, not the linked surface. Source: [working-with-databases](https://developers.notion.com/guides/data-apis/working-with-databases#structure).
- **The data_sources array order is not guaranteed stable.** Don't index by position; match by name or stored ID.

## When to update this file

- After every Notion API version bump in `@notionhq/client` package.json
- When you hit a 4xx error worth remembering (especially `validation_error` patterns)
- When Notion announces a deprecation or a new endpoint we should adopt
- When the deep-research agent's output arrives — incorporate the new findings, mark this file's "TL;DR" as updated

## Last touched

2026-05-15 — Initial seed. Deep-research output pending. Awaiting full API survey to expand sections marked "pending verification."
