# Competitor-intel cron (newsletters → Notion)

A real, live-bot cron (`src/crons/competitor-intel.ts`, registered in `src/server.ts`, runs weekly Monday 08:30 Europe/Lisbon) that reads competitor and "inspiration" business newsletters and turns them into a running record of market intelligence in Notion — events, promotions/campaigns, positioning changes, product/service launches.

**Fully automatic, no review gate before writing to Notion** — same design choice as [tidy-mailboxes](tidy-mailboxes.md), for the same reason: a wrong extraction is low-stakes (the source email link is kept, and `Categoria` is deliberately left for a human anyway — see below), not a business record silently propagating a wrong guess.

## Current design: a dedicated Outlook shared mailbox

As of 2026-09-21, the live pipeline is `src/lib/outlook-competitor-intel-pipeline.ts`, reading a **dedicated Outlook shared mailbox** (`OUTLOOK_COMPETITOR_INTEL_MAILBOX`) that a founder manually resubscribes every competitor/inspiration newsletter under — nothing else is meant to land there.

This is a **single phase**, unlike the original Gmail design below — there's no sender-matching "tidy" step, because the mailbox itself IS the curated intake. The "Fontes Concorrência/Inspiração" Notion DB (`getActiveCompetitorSources`) is **not consulted by this pipeline** — it's purely the founder's own reference list of what she's subscribed and how she classifies each source, not a filter the code reads. (A source row's `Categoria` still isn't copied onto findings automatically — see "Why `Categoria` is left blank" below, which still applies.)

State model: **still in Inbox IS the to-do queue**, the same trick `tidy-mailboxes.ts` uses. Archiving a message (`outlook.archiveMessage`) is what removes it from `listInboxMessages`' scope — there's no separate "already processed" flag to maintain or that can drift out of sync. The `OUTLOOK_COMPETITOR_INTEL_PROCESSED_CATEGORY` Outlook category applied alongside archiving is purely a visual marker for a founder browsing the Archive folder later; it's never read back by the pipeline, so a failure to apply it (logged as a warning, not counted as an error) can never cause a message to be reprocessed or skipped incorrectly. Archiving happens *before* the category tag for exactly this reason — see the module docstring.

OAuth reuses the same Microsoft app registration and consent already granted for `tidy-mailboxes`/`outlook-partnerships-sync` (`MICROSOFT_CLIENT_ID`/`SECRET`/`TENANT_ID`, `Mail.ReadWrite(.Shared)`) — no new scope, no new consent flow. The dedicated mailbox needs Exchange Full Access delegation to whichever account holds the token, same as any address in `OUTLOOK_MAILBOXES`.

## Why this replaced the original Gmail design

The original build (2026-09-15) read a dedicated Gmail account (`yourhavenpilates@gmail.com`) via the Gmail API, `gmail.modify` scope. That hit a real wall before it could ever run unattended: **`gmail.modify` is a Google "restricted" scope**. An unverified OAuth app can only use restricted scopes while its consent screen is in "Testing" publishing status with the account added as a test user — and Testing-status apps get **refresh tokens capped at 7 days**. That's fine for a one-off script, fatal for a cron meant to run unattended every Monday. Full Google verification (and, for a restricted scope, likely a paid CASA security assessment) wasn't worth it for a tool with 2-3 users. Making the Gmail account a paid Google Workspace account (enabling "Internal" OAuth user type, which has neither problem) was the other option — rejected on budget grounds.

Microsoft's equivalent for a single-tenant Azure AD app used only within your own paid Microsoft 365 org has no equivalent restriction: no verification requirement, no forced refresh-token expiry, because Microsoft already trusts organization-internal admin consent. Since the studio already pays for Outlook/Microsoft 365, and this codebase already had a fully-authorized `src/lib/outlook.ts` client with the exact scopes needed (`Mail.ReadWrite(.Shared)`, used by `tidy-mailboxes.ts`), porting was the natural fix.

### The old Gmail code still exists — as a one-off backfill tool only

`src/lib/gmail.ts`, `src/lib/competitor-intel-pipeline.ts` (`processTaggedCompetitorEmails()`), and `scripts/backfill-competitor-intel.mjs` were **kept exactly as originally built**, purely to run once against the real backlog that had already accumulated in `yourhavenpilates@gmail.com` (43 emails, tagged by hand with the `email marketing concorrência` Gmail label) before the migration. They are **no longer used by the live cron** — `src/crons/competitor-intel.ts` now imports `outlook-competitor-intel-pipeline.ts` exclusively.

The old two-phase design (tidy: scan Inbox for known senders from the Fontes DB, label + archive; process: extract from labelled-but-unprocessed messages) made sense when reading a personal-style inbox that received other mail too. Both phases are Gmail-label-state-driven, not backed by a timestamp/checkpoint file — see the historical comments still in those files for the full reasoning, unchanged.

**These files are safe to delete once the final Gmail backfill run is done** — see the setup checklist below.

## Why `Categoria` is left blank by the bot

The extractor (`extract-competitor-intel.ts`) deliberately does **not** decide Concorrência vs. Inspiração, in either pipeline. The founder-maintained "Fontes" DB does carry its own `Categoria` field, but nothing in either write path copies it onto a finding — the founder classifies each finding by hand in the Competitor Intel DB. This was an explicit founder decision (not a technical constraint): letting the bot guess here was judged more error-prone and less useful than a human doing it once, briefly, while reviewing what came in.

## Why `Tipo` can grow

The extractor's system prompt lists four known categories (Evento, Promoção/Campanha, Posicionamento/Mensagem, Produto/Serviço) but explicitly allows Claude to propose a new short pt-PT tag when nothing fits. `Tipo` is a Notion multi-select with **options deliberately omitted from `scripts/setup-notion-dbs.mjs`** — see `notion-api-gotchas.md` TL;DR item 8: declaring a fixed (or empty) options list for a dynamically-growing select wipes any options not listed on every schema-sync run. The founder prunes bad/noisy tags by hand later.

## Setup checklist (manual steps, in order)

1. Create the two Notion DBs ("Fontes Concorrência/Inspiração", "Competitor Intel") and share both with the haven-va integration (per the `add-notion-db` skill). The title property on a fresh Notion database defaults to "Name" — rename it to "Nome" before first use (the bot reads/writes "Nome" specifically); everything else in `scripts/setup-notion-dbs.mjs` pushes cleanly regardless of rename order.
2. Add their ids to `.env` (`NOTION_COMPETITOR_SOURCES_DB_ID`, `NOTION_COMPETITOR_INTEL_DB_ID`) and run `node --env-file=.env scripts/setup-notion-dbs.mjs`.
3. In the Notion "Fontes" DB, add a row per newsletter source (Nome, Email/Domínio, Categoria, Ativo) — this is a reference list for the founder now, not something the live Outlook pipeline reads, but still worth keeping current.
4. **One-time Gmail backfill of the pre-migration backlog** (skip if there was none): enable the Gmail API + `gmail.modify` scope on the Google Cloud project behind `GOOGLE_CLIENT_ID` (Testing status + test user is fine for a single short-lived run), run `/auth_gmail` in Madalena's Telegram DM, then `COMPETITOR_INTEL_DRY_RUN=true node --env-file=.env.local scripts/backfill-competitor-intel.mjs` to sanity-check, then the real run. Afterward, `GOOGLE_REFRESH_TOKEN_GMAIL_COMPETITOR`, `COMPETITOR_INTEL_LABEL`/`_PROCESSED_LABEL`, `src/lib/gmail.ts`, `src/lib/competitor-intel-pipeline.ts`, and this script can all be deleted.
5. Provision the dedicated Outlook shared mailbox (e.g. `concorrencia@thehavenpilates.pt`) in the Microsoft 365 admin center, and grant Full Access + Send As delegation to whichever account holds the Microsoft OAuth token — same pattern as any `OUTLOOK_MAILBOXES` entry. This is an admin-center action; nothing in this codebase can provision a mailbox itself.
6. Manually resubscribe every source in the Fontes DB to receive its newsletter at the new mailbox address.
7. Set `OUTLOOK_COMPETITOR_INTEL_MAILBOX` in `.env` to that address.
8. Sanity-check: `COMPETITOR_INTEL_DRY_RUN=true node --env-file=.env.local` then run the cron once manually (or wait for real mail to accumulate), review the logged findings before trusting it live.
9. Leave the weekly cron running unattended from here — it'll process every Monday 08:30 and post one Telegram digest either way (including a "nada de novo esta semana" message on a quiet week, so founders know it ran).

## `COMPETITOR_INTEL_DRY_RUN`

Set to `true` to run the full extraction logic against the real mailbox (Gmail backfill or live Outlook pipeline — both read this same flag) and Notion config without mutating anything — no category/label changes, no archiving, no Notion writes. Same pattern as `TIDY_MAILBOXES_DRY_RUN`. Use before trusting a prompt change against real mail.

## When to update this doc

- The extractor's system prompt or known `Tipo` categories change.
- The Outlook pipeline's single-phase shape changes, or the Fontes DB becomes an active filter again (currently deliberately not consulted — see above).
- The Outlook mailbox, category name, or delegation setup changes.
- The Gmail backfill files are finally deleted — note the date and that the migration is fully complete.
- A founder reports a systematic miss (a real finding never extracted, wrong `Fonte` attribution) worth recording as a known gap.
