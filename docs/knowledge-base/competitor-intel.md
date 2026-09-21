# Competitor-intel cron (newsletters → Notion)

A real, live-bot cron (`src/crons/competitor-intel.ts`, registered in `src/server.ts`, runs weekly Monday 08:30 Europe/Lisbon) that reads a **dedicated Outlook shared mailbox** — a founder manually resubscribes every competitor/inspiration business newsletter under it — and turns them into a running record of market intelligence in Notion: events, promotions/campaigns, positioning changes, product/service launches.

**Fully automatic, no review gate before writing to Notion** — same design choice as [tidy-mailboxes](tidy-mailboxes.md), for the same reason: a wrong extraction is low-stakes (the source email link is kept, and `Categoria` is deliberately left for a human anyway — see below), not a business record silently propagating a wrong guess.

## Why a dedicated mailbox, and why that makes it a single phase

The mailbox exists for exactly one purpose: receive competitor/inspiration newsletters, nothing else. That single fact simplifies the whole design relative to a general-purpose inbox:

- **No sender-matching "tidy" step.** The pipeline (`src/lib/outlook-competitor-intel-pipeline.ts`, `processOutlookCompetitorIntel()`) doesn't scan for known senders — everything that lands in this mailbox IS the intake. The "Fontes Concorrência/Inspiração" Notion DB (`getActiveCompetitorSources`) is **not read by this pipeline at all** — it's purely the founder's own reference list of what she's subscribed and how she classifies each source.
- **No category tag, no archiving.** A message's Outlook **`isRead`** flag alone is the "processed" state — unread means not yet turned into a Notion finding. The pipeline marks a message read only after every Notion write for it succeeds; an error leaves it unread and it's retried automatically on the next run, with zero extra bookkeeping. This was a deliberate simplification (2026-09-21) over an earlier version that also applied a "processed" category and moved messages to Archive — unnecessary ceremony for a mailbox nothing else touches or needs kept tidy.

OAuth reuses the same Microsoft app registration and consent already granted for `tidy-mailboxes`/`outlook-partnerships-sync` (`MICROSOFT_CLIENT_ID`/`SECRET`/`TENANT_ID`, `Mail.ReadWrite(.Shared)`) — no new scope, no new consent flow. The dedicated mailbox needs Exchange Full Access delegation to whichever account holds the token, same as any address in `OUTLOOK_MAILBOXES`.

## Why Outlook and not Gmail

The original build (2026-09-15) read a dedicated Gmail account via the Gmail API, `gmail.modify` scope. That hit a real wall before it could ever run unattended: **`gmail.modify` is a Google "restricted" scope**. An unverified OAuth app can only use restricted scopes while its consent screen is in "Testing" publishing status with the account added as a test user — and Testing-status apps get **refresh tokens capped at 7 days**. Fine for a one-off script, fatal for a cron meant to run unattended every Monday. Full Google verification (and, for a restricted scope, likely a paid CASA security assessment) wasn't worth it for a tool with 2-3 users; making the Gmail account a paid Google Workspace account (enabling "Internal" OAuth user type, which has neither problem) was rejected on budget grounds.

Microsoft's equivalent for a single-tenant Azure AD app used only within your own paid Microsoft 365 org has no equivalent restriction — no verification requirement, no forced refresh-token expiry. Since the studio already pays for Outlook/Microsoft 365, and this codebase already had a fully-authorized `src/lib/outlook.ts` client with the exact scopes needed, porting was the natural fix. The old Gmail code (`src/lib/gmail.ts`, `src/lib/competitor-intel-pipeline.ts`, `scripts/backfill-competitor-intel.mjs`, the `/auth_gmail` bot command) was **deleted outright** once the pre-migration Gmail backlog was cleared — see below — rather than kept around as dead weight, since nothing in the live pipeline needs it.

## How the pre-migration Gmail backlog got into Notion

The 43 emails already tagged with the `email marketing concorrência` Gmail label in `yourhavenpilates@gmail.com` (predating this whole feature) were **not** processed through the Gmail API or `/auth_gmail` at all. Doing that one-time OAuth dance just to run a single backfill script wasn't worth building/maintaining — instead, Claude read each email directly in the browser (already signed into `yourhavenpilates@gmail.com`) and wrote findings straight to the Competitor Intel Notion DB by hand, applying the exact same judgment the Haiku extractor would (see "Why `Tipo` can grow" below) and skipping anything purely transactional (account-verification emails, password-setup links, invoices) that carried no real competitive intel. This was a one-time, one-off action — there's no code path for it and none is needed; the live Outlook pipeline is unrelated.

## Why `Categoria` is left blank by the bot

The extractor (`extract-competitor-intel.ts`) deliberately does **not** decide Concorrência vs. Inspiração. The founder-maintained "Fontes" DB does carry its own `Categoria` field, but nothing in the write path copies it onto a finding — the founder classifies each finding by hand in the Competitor Intel DB. This was an explicit founder decision (not a technical constraint): letting the bot guess here was judged more error-prone and less useful than a human doing it once, briefly, while reviewing what came in.

## Why `Tipo` can grow

The extractor's system prompt lists four known categories (Evento, Promoção/Campanha, Posicionamento/Mensagem, Produto/Serviço) but explicitly allows Claude to propose a new short pt-PT tag when nothing fits. `Tipo` is a Notion multi-select with **options deliberately omitted from `scripts/setup-notion-dbs.mjs`** — see `notion-api-gotchas.md` TL;DR item 8: declaring a fixed (or empty) options list for a dynamically-growing select wipes any options not listed on every schema-sync run. The founder prunes bad/noisy tags by hand later.

## Setup checklist (manual steps, in order)

1. Create the two Notion DBs ("Fontes Concorrência/Inspiração", "Competitor Intel") and share both with the haven-va integration (per the `add-notion-db` skill). The title property on a fresh Notion database defaults to "Name" — rename it to "Nome" before first use (the bot reads/writes "Nome" specifically).
2. Add their ids to `.env` (`NOTION_COMPETITOR_SOURCES_DB_ID`, `NOTION_COMPETITOR_INTEL_DB_ID`) and run `node --env-file=.env scripts/setup-notion-dbs.mjs`.
3. In the Notion "Fontes" DB, add a row per newsletter source (Nome, Email/Domínio, Categoria, Ativo) — a reference list for the founder, not something the pipeline reads, but worth keeping current.
4. Provision the dedicated Outlook shared mailbox (e.g. `diana@thehavenpilates.pt`) in the Microsoft 365 admin center, with Full Access + Send As delegation to whichever account holds the Microsoft OAuth token — same pattern as any `OUTLOOK_MAILBOXES` entry. This is an admin-center action; nothing in this codebase can provision a mailbox itself.
5. Manually resubscribe every source in the Fontes DB to receive its newsletter at the new mailbox address. In practice this usually means creating an account / booking an intro offer at each studio's own booking platform (Mindbody, Momence, Squarespace member areas, …) using that mailbox address — most of these studios don't run a plain standalone "enter your email" newsletter form; their marketing lists are tied to their booking accounts. Account creation isn't something Claude does on a founder's behalf.
6. Set `OUTLOOK_COMPETITOR_INTEL_MAILBOX` in `.env` to that address.
7. Sanity-check: `COMPETITOR_INTEL_DRY_RUN=true` against the real mailbox once it has real mail, review the logged findings before trusting it live.
8. Leave the weekly cron running unattended from here — it'll process every Monday 08:30 and post one Telegram digest either way (including a "nada de novo esta semana" message on a quiet week, so founders know it ran).

## `COMPETITOR_INTEL_DRY_RUN`

Set to `true` to run the full extraction logic against the real mailbox and Notion config without mutating anything — no `isRead` change, no Notion writes. Same pattern as `TIDY_MAILBOXES_DRY_RUN`. Use before trusting a prompt change against real mail.

## When to update this doc

- The extractor's system prompt or known `Tipo` categories change.
- The pipeline's single-phase shape changes, or the Fontes DB becomes an active filter again (currently deliberately not consulted — see above).
- The dedicated mailbox address, or its delegation setup, changes.
- A founder reports a systematic miss (a real finding never extracted, wrong `Fonte` attribution) worth recording as a known gap.
