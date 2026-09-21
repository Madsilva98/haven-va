# Competitor-intel cron (Gmail newsletters → Notion)

A real, live-bot cron (`src/crons/competitor-intel.ts`, registered in `src/server.ts`, runs weekly Monday 08:30 Europe/Lisbon) that reads competitor and "inspiration" business newsletters from a dedicated Gmail account and turns them into a running record of market intelligence in Notion — events, promotions/campaigns, positioning changes, product/service launches.

**Fully automatic, no review gate before writing to Notion** — same design choice as [tidy-mailboxes](tidy-mailboxes.md), for the same reason: a wrong extraction is low-stakes (the source email link is kept, and `Categoria` is deliberately left for a human anyway — see below), not a business record silently propagating a wrong guess.

## Why two phases, and why they're separate concerns

1. **Tidy** (`src/crons/competitor-intel.ts`, phase 1): scans the Inbox for messages from the founder-maintained sender list (the "Fontes Concorrência/Inspiração" Notion DB), tags matches with the Gmail label named by `COMPETITOR_INTEL_LABEL` (default `email marketing concorrência` — a label the founder already created by hand; the bot never creates this one, only looks it up), and archives them (removes the `INBOX` label).
2. **Process** (`src/lib/competitor-intel-pipeline.ts`, `processTaggedCompetitorEmails()`, phase 2): finds messages carrying that label but not yet `COMPETITOR_INTEL_PROCESSED_LABEL` (default `email marketing concorrência: processado`, created by the bot on first use), extracts findings with Claude Haiku (`src/lib/extract-competitor-intel.ts`), writes each finding to the Competitor Intel Notion DB, then applies the "processado" label.

These are split into two functions/phases (not one), and phase 2 lives in its own module, because **it's reused verbatim by `scripts/backfill-competitor-intel.mjs`** — the one-off script a founder runs once, right after completing `/auth_gmail`, to process the real backlog of already-tagged emails that predates this code, without waiting for the next Monday run and without re-running the tidy phase against the Inbox.

## Why labels instead of a state file

Both phases are entirely **Gmail-state-driven**, not backed by any timestamp or checkpoint file:
- Tidy only ever looks at the current Inbox (`in:inbox ...`) — once a message is archived, it structurally can't show up again, so there's nothing to track.
- Process only ever looks at `label:"<main>" -label:"<processed>"` — a message either has the "processado" label or it doesn't.

This means: a message that errors during extraction or the Notion write simply **doesn't get the "processado" label**, and is automatically retried on the very next run (weekly cron or a re-run of the backfill script) with zero extra bookkeeping. See `processTaggedCompetitorEmails()` in `src/lib/competitor-intel-pipeline.ts` — extraction failures and Notion write failures are both caught per-message and counted as errors, never silently swallowed into a false "processado".

## Why two separate Google/OAuth setups

The Gmail account this reads (`yourhavenpilates@gmail.com`) is a **different Google account** from the one already authorized for Google Calendar (Madalena's personal account, `src/lib/calendar.ts`). They reuse the same `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` OAuth app (one Google Cloud project can serve multiple APIs/accounts), but:
- `src/lib/gmail.ts` mirrors `calendar.ts`'s file-based-refresh-token pattern exactly, but stores its token in a **separate file**, `DATA_DIR/gmail-competitor-tokens.json`.
- The Telegram auth command is **`/auth_gmail`**, independent of `/auth` (Calendar) — separate `awaitingGmailAuthCodeFrom` flag in `src/bot/index.ts`, so running one auth flow never disturbs the other's stored token.
- Scope is `gmail.modify` (not `readonly`) — the tidy phase needs to add a label and remove `INBOX`.

**One-time manual setup required** (not something code can do): in the Google Cloud project already used for Calendar, enable the Gmail API and add the `gmail.modify` scope to the OAuth consent screen, then run `/auth_gmail` in Madalena's Telegram DM, signing in as `yourhavenpilates@gmail.com`.

## Why `Categoria` is left blank by the bot

The extractor (`extract-competitor-intel.ts`) deliberately does **not** decide Concorrência vs. Inspiração. The founder-maintained "Fontes" DB does carry its own `Categoria` field, but nothing in the write path copies it onto a finding — the founder classifies each finding by hand in the Competitor Intel DB. This was an explicit founder decision (not a technical constraint): letting the bot guess here was judged more error-prone and less useful than a human doing it once, briefly, while reviewing what came in.

## Why `Tipo` can grow

The extractor's system prompt lists four known categories (Evento, Promoção/Campanha, Posicionamento/Mensagem, Produto/Serviço) but explicitly allows Claude to propose a new short pt-PT tag when nothing fits. `Tipo` is a Notion multi-select with **options deliberately omitted from `scripts/setup-notion-dbs.mjs`** — see `notion-api-gotchas.md` TL;DR item 8: declaring a fixed (or empty) options list for a dynamically-growing select wipes any options not listed on every schema-sync run. The founder prunes bad/noisy tags by hand later.

## Setup checklist (manual steps, in order)

1. Create the two Notion DBs ("Fontes Concorrência/Inspiração", "Competitor Intel") and share both with the haven-va integration (per the `add-notion-db` skill).
2. Add their ids to `.env` (`NOTION_COMPETITOR_SOURCES_DB_ID`, `NOTION_COMPETITOR_INTEL_DB_ID`) and run `node --env-file=.env scripts/setup-notion-dbs.mjs`.
3. In the Notion "Fontes" DB, add rows for every newsletter sender to watch (Nome, Email/Domínio, Categoria, Ativo=true).
4. In Gmail, confirm the `email marketing concorrência` label already exists (create it if not — the bot never creates this one, only looks it up).
5. In Google Cloud Console: enable the Gmail API on the project behind `GOOGLE_CLIENT_ID`, add the `gmail.modify` scope to the OAuth consent screen.
6. Run `/auth_gmail` in Madalena's Telegram DM, authorizing as `yourhavenpilates@gmail.com`.
7. Sanity-check against the real backlog first: `COMPETITOR_INTEL_DRY_RUN=true node --env-file=.env.local scripts/backfill-competitor-intel.mjs`, review the logged findings.
8. Real backfill run: `node --env-file=.env.local scripts/backfill-competitor-intel.mjs`. Spot-check the written Notion rows and that the "processado" label landed on the right messages.
9. Leave the weekly cron running unattended from here — it'll tidy + process every Monday 08:30 and post one Telegram digest either way (including a "nada de novo esta semana" message on a quiet week, so founders know it ran).

## `COMPETITOR_INTEL_DRY_RUN`

Set to `true` to run the full tidy + extraction logic against the real inbox and Notion config without mutating anything — no label changes, no archiving, no Notion writes. Same pattern as `TIDY_MAILBOXES_DRY_RUN`. Use before trusting a prompt or sender-list change against real mail.

## When to update this doc

- The extractor's system prompt or known `Tipo` categories change.
- The tidy/process split changes shape, or a new caller of `processTaggedCompetitorEmails()` is added.
- The Gmail OAuth scope or account changes.
- A founder reports a systematic miss (wrong sender matched, a real finding never extracted) worth recording as a known gap.
