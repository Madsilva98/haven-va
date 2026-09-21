# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Knowledge base (read this if you haven't worked on the bot in a while)

The `docs/knowledge-base/` folder is the durable memory of "how this bot actually works, where it breaks, how to operate it." Start with [`docs/knowledge-base/README.md`](docs/knowledge-base/README.md). Skim the relevant topic doc before touching the area you're about to change:

- [`bot-architecture.md`](docs/knowledge-base/bot-architecture.md) — 10-minute mental model: message flow, file map, cron schedule, state model
- [`deploy-and-access.md`](docs/knowledge-base/deploy-and-access.md) — NAS access (Tailscale, DSM, Container Manager), deploy pipeline, rollback, secret hygiene
- [`notion-api-gotchas.md`](docs/knowledge-base/notion-api-gotchas.md) — data sources vs databases, schema brittleness, retry strategy, property type quirks
- [`outlook-partnerships-sync.md`](docs/knowledge-base/outlook-partnerships-sync.md) — Outlook → Notion Partner Pipeline sync (adjacent tooling, not the live bot): Azure setup, gotchas, checkpoint mechanism
- [`pulse-views.md`](docs/knowledge-base/pulse-views.md) — the studio numbers: which `v_pulse_*` view answers what, the data-as-of rule, `pulse_cases`, `/flag`, "porquê?", the `kenko_` guard
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
  ├── slash command → src/bot/commands.ts (handleTask, handleHoje, handleDashboard, …), src/bot/pulse.ts (/flag, /casos)
  ├── inline callback → src/bot/callbacks.ts + week/todiscuss handlers
  ├── DM (private chat) → src/bot/dm.ts
  ├── "porquê?" after a studio number → src/bot/pulse.ts (handleWhy: the source view's COMMENT)
  └── group text → src/bot/assistant.ts (handleAssistant)
                      └── Claude Haiku call with tool_use
                            └── tools execute → src/notion.ts
```

`src/bot/index.ts` (`buildBot`) owns the routing logic and registers all handlers. It also handles file uploads (documents/photos → Notion page attachment) and Google Calendar OAuth intercept.

### Assistant (`src/bot/assistant.ts`)

Single Claude Haiku call per group message with `tool_choice: "auto"`. Tools defined inline: `create_task`, `create_reminder`, `log_entry`, `log_decision`, `update_record`, `search_records`, `create_entity`, `add_to_discuss`, `set_focus`, `create_calendar_event`, `create_content_calendar_entry`, `add_to_list`, `add_to_page_section`. The system prompt is loaded from `src/prompts/assistant.md` at startup via `readFileSync` and passed as an ephemeral-cached block.

Context injected into every user message: current datetime (Lisbon TZ), sender's open tasks from Notion, recent conversation history (`src/bot/history.ts`), content calendar rows (only when message matches calendar keywords), last bot replies.

### Studio numbers (`src/lib/pulse-views.ts`)

**Studio numbers come only from `v_pulse_*` views. A number that looks wrong becomes a `pulse_cases` row, never a local fix.** The bot connects to the studio project as Postgres role `haven_va` (`STUDIO_DATABASE_URL`, `src/lib/studio-db.ts`), whose search path is schema `va`: mirrors of the studio's curated views plus an insert-only `pulse_cases`. It cannot read a `kenko_*` table — `test/kenko-guard.test.ts` fails on any such literal in `src/`, and its allowlist (`src/lib/kenko-allowlist.json`) is empty. `src/lib/pulse-views.ts` is the only reader; "today" is the data-as-of date (`max(cycle_starts_at) <= today` over `v_pulse_membership_state`), never the calendar; `member_id = md5(lower(email))` is the join key and `v_pulse_member_identity` the one PII view. No staff list lives in the bot: the views exclude staff. Every number the bot posts ends with `Fonte: v_pulse_…`; "porquê?" in the group answers with that view's COMMENT and column comments (`obj_description` / `col_description`, live); `/flag <texto>` records a wrong number as an open case; `/casos` lists them. Spec and inventory: `docs/plans/2026-09-21-pulse-views-spec.md`; operating notes: `docs/knowledge-base/pulse-views.md`.

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
| `birthdays.ts` | 08:00 daily | Posts to the group if anyone in the birthday audience (paying member per `v_pulse_membership_state` as of the data date, class-pack holder with credits per `v_pulse_classpack_state`, or intro holder per `v_pulse_intro_holder_state`) has a birthday **today** per `v_pulse_member_identity` (simplified from a 7-day-ahead preview 2026-09-15). Depends on `STUDIO_DATABASE_URL`; if you see `studio_db.disabled` in NAS logs, that's a regression, not expected state. |
| `tidy-mailboxes.ts` | 07:00 daily | Fully automatic Outlook inbox tidying (archive/forward) — disabled unless `OUTLOOK_TIDY_MAILBOXES` is set |
| `intro-pack-expiring.ts` | 08:15 daily | Plain Telegram digest (no Notion write) of still-active intro packs expiring in the next 3 days, filtered to two usage patterns worth a same-day nudge (`src/lib/intro-pack-conversion.ts` `findExpiringIntroPacksToWatch`): 2-Class packs where only 1 of 2 classes has been used, and 10-Day packs where more than 5 classes have been used. Expiry is `v_pulse_intro_purchase.intro_end` (Kenko's real date), attendance `v_pulse_member_activity`. Founder's spec, 2026-09-20 — not empirically derived like the day-21 unconverted threshold below. |
| `leads-reconcile.ts` | 08:10 Mon | Cleans up "Leads a contactar" before the scans below add anything new — founder wants this list "viva": archives any row Estado is `Perdido`, `Convertido`, or `Inconclusivo` (whether she set that by hand in Notion, or it was already there) unconditionally, plus auto-detects genuine conversions on still-open (`Novo`/`Contactado`) rows and archives those too — channel-aware: Email/WhatsApp/Instagram leads via `src/lib/leads.ts` `hasRealPurchase`, Intro Pack leads via `v_pulse_intro_conversion` (`converted` or `converted_pack`; their own intro-pack purchase is NOT a conversion signal — using `hasRealPurchase` for them mass-archived all open Intro Pack leads in production on 2026-09-16, since fixed). Either way, converted leads are archived outright, never left as a visible "Convertido" row. **Exception:** `Perdido`/`Inconclusivo` rows on the `Intro Pack` channel are left un-archived (still visible) — archiving them made them invisible to `leads-intro-pack.ts`'s dedup check below, which silently recreated the same person as a fresh "Novo" lead the following Monday, undoing the founder's call (broke in production 2026-09-21, e.g. Marta Somborn; founder's call to trade "always tidy" for correctness on this one channel). `Inconclusivo` (added 2026-09-21) is for when the message thread alone doesn't say whether someone converted or was lost — same terminal weight as `Perdido`/`Convertido`, so it gets the same archive behaviour (and the same Intro Pack exception). |
| `leads-instagram-scan.ts` | 08:12 Mon | Scans Mafalda's own Instagram DM inbox tables in Studio Supabase (`inbox_contacts`/`inbox_messages` — see `docs/knowledge-base/bot-architecture.md`) via `src/lib/instagram-inbox.ts`, classifying per CONTACT (one Haiku call on their whole transcript via `src/lib/lead-classifier.ts`'s `classifyInstagramDM`, not per message) into `cliente` / `parceiro` / `influencer` / `nenhum`. `cliente` (genuine information request from a prospective client) writes into "Leads a contactar", `Canal = "Instagram"`, matched against `kenko_customers` by name (`src/lib/leads.ts` `checkExistingCustomer`, unchanged) since most Instagram DMs carry no email/phone. `parceiro` (another Pilates/wellness business proposing a genuine business collaboration — workshop, event, corporate, cross-promotion) writes into "Partner Pipeline" instead (`notion.createPartner`, `Categoria = "Parceria"`, `Status = "A contactar"`) — founder's call, 2026-09-21, so these don't dilute the client-leads list; she moves it to "On hold"/"Arquivado" by hand like every other partner contact. `influencer` (a content creator offering to try a class in exchange for posting about it) writes into "Influencer Pipeline" instead (`notion.createInfluencer`, `Canal de contacto = "Instagram DM"`) — kept separate from `parceiro` since that DB already has the right fields (follower count, collaboration type). The prompt explicitly excludes job applications and vendor/supplier sales pitches from `parceiro`/`influencer` — those are `nenhum` (founder's call, 2026-09-21, after the dry-run review turned up a cleaning-supplies vendor and several "are you hiring?" messages wrongly landing as partner candidates). **Before classifying at all**, a contact with zero inbound messages (`src/lib/instagram-inbox.ts` `hasInboundMessage`) — i.e. the studio cold-messaged them, e.g. an influencer/brand outreach campaign, and they never replied — skips the Haiku call entirely and goes straight into Partner Pipeline with `Status = "Contactado"` instead: an out-only transcript still contains the studio's own "parceria" language and fooled the classifier into a false "parceiro" the first time this shipped (2026-09-21), and separately, the founder wants these tracked too, just correctly labelled as "we already reached out." Own checkpoint file (`data/instagram-leads-sync-state.json`) is the ONLY dedup mechanism here — most Instagram contacts have no email, so the email-keyed `findLeadByEmail`/`findLeadByEmailAny` can't help; state is saved after every contact (not batched) so a crash mid-run can't duplicate a page, and once a contact has a `notionPageId` (lead, partner, OR influencer) a second page is never created for them, even after new messages or a manual status change. First run (empty checkpoint) doubles as the historical backfill — no separate one-off script needed. Exclusion list (`EXCLUDED_INSTAGRAM_NAMES` in `src/lib/instagram-inbox.ts`) covers staff/founders AND known peer/business Instagram contacts, seeded 2026-09-21 from the founder's own list, matched by **substring** (not exact equality) against normalized display name/username — Instagram sometimes glues extra text onto a display name (e.g. an email address pasted in), which broke an exact-match check for "Susana Vie" in production the same day — extend the list via `scripts/dry-run-instagram-leads.mjs`'s review output before relying on a live run. WhatsApp is NOT covered yet — its Meta webhook is still blocked on Business Verification. |
| `leads-email-scan.ts` | **disabled** 2026-09-16 | Not registered in `src/server.ts` — founder's call. Would scan `OUTLOOK_MAILBOXES` for genuine information-request emails, but excludes the Archive folder, and `tidy-mailboxes.ts` auto-archives anything its classifier judges resolved with no human review — a genuine unanswered inquiry misjudged as resolved would silently vanish from this scan with no trace. Combined with email being low-volume next to Instagram/WhatsApp/phone here, not worth it. Code left in place; see the file's own docstring for how to re-enable. |
| `leads-intro-pack.ts` | 08:20 Mon | Flags people whose first 2-Class / 10-Day pack (`v_pulse_intro_purchase`, `intro_end` = Kenko's real expiry) ended 21+ days ago and who are neither `converted` nor `converted_pack` in `v_pulse_intro_conversion` (a 5x/10x pack counts as converted; a drop-in does not) — the day-21 threshold and "no pack-type split needed" were both empirically validated, not assumed. Writes into the same "Leads a contactar" DB, `Canal = "Intro Pack"`. |
| `churn-risk.ts` | 08:45 Mon | First sweeps away any row Status="Resolvido"/"Arquivado" (founder sets that by hand — same "stay alive" behaviour as `leads-reconcile.ts`), then computes 3 empirically validated signals from the views, for every paying member as of the data date (no booked class 14+ days per `v_pulse_member_activity` / failed payment in 45 days per `v_pulse_failed_payments` / <50% in each of the last 3 full months per `v_pulse_utilization_monthly`, skipping `had_pause` months) — see `src/lib/churn-signals.ts` for why the "obvious" signals (no-show rate, unused credits, days-since-cancellation) were tested and rejected. Writes/updates the Notion "Clientes em risco" DB, digest only for what's new/changed this week. A number that looks wrong is a `pulse_cases` row (`/flag`), not a local fix: the false positives so far were Kenko import lag or a view rule, never bot arithmetic. |

### Types (`src/types.ts`)

All shared types live here: `FounderName`, `Area`, `Priority`, `Status`, all row interfaces (`ReminderRow`, `ToDiscussRow`, `PartnerRow`, etc.), all intent types. When adding a new Notion DB or field, add the type here first.

### Founder identity

Founders identified by Telegram user ID → name via `src/lib/founders.ts`. IDs come from env vars `TELEGRAM_MADALENA_ID`, `TELEGRAM_MAFALDA_ID`, `TELEGRAM_BEATRIZ_ID`. All Notion writes use the string name (`FounderName`), never the ID.

## Key conventions

- All user-facing text in pt-PT.
- Logs use structured JSON via `src/lib/log.ts` (`log.info`, `log.warn`, `log.error`), always with a dotted label and a data object: `log.info("notion.thing_done", { id })`.
- Timezone is always `Europe/Lisbon`. Use `src/lib/tz.ts` for conversions.
- The bot only responds to known founders (checked via `isFounder(fromId)`). Unknown users are silently ignored.
- `dist/` is committed alongside `src/` (the NAS Dockerfile copies it; `npm run build` on deploy rebuilds it anyway) — always build before committing so the two never drift.
- `.md` prompt files (`src/prompts/`) are copied to `dist/prompts/` by `scripts/copy-assets.mjs` at build time.

## Environment variables

See `.env.example`. Notion DB IDs are all optional except `NOTION_BACKLOG_DB_ID` — missing IDs disable the corresponding feature gracefully.
