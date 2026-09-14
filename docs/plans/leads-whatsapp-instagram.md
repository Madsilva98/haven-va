# Plan: leads database from WhatsApp/Instagram DMs

Status: **proposed, not started**. Saved 2026-09-14 pending founder review of Phase 0 (Meta Business Verification / App Review) before any code work begins.

## Context

The Haven wants a database of leads that reach out via WhatsApp or Instagram DM and never get followed up. Two constraints from the founder: **read-only** (never send anything back through these channels) and **only messages that look like genuine information requests** get saved — not every message.

Research + a codebase check settled the shape of what's actually buildable:

- **Historical messages are not recoverable via any free/official API**, on either platform. Meta does not expose an endpoint to pull DMs/chats that existed before a webhook was connected — you only get what arrives *after* setup. The only way to recover what's already in the WhatsApp Business App today is a manual, per-chat "Export chat" from the phone (no bulk, no API). The founder confirmed the scope should be **forward-only: capture new incoming messages from now on** — this plan does not attempt historical recovery.
- **WhatsApp**: currently the normal WhatsApp Business App on a phone. Meta's **Coexistence** mode (globally available in 2026) lets the same number run the phone app *and* the Cloud API side-by-side, synced in real time, without losing chat history or changing how the founders use the app day to day — the app just needs to be opened at least once every 13 days to stay active. Receiving/reading messages through the Cloud API is free; only sending has a cost, and this project never sends.
- **Instagram**: already a professional (Business/Creator) account linked to a Facebook Page — the baseline requirement is met. However, reading DMs from real customers (not just the app's own testers) requires **Advanced Access to `instagram_business_manage_messages`**, gated behind **Meta App Review + Business Verification** — typically weeks, sometimes longer. Until that's approved, the Instagram side will only receive messages sent by accounts added as app testers, which is enough to build and test the pipeline but not to capture real leads. **This is the main schedule risk and is outside engineering's control.**
- **No public HTTPS endpoint exists today.** `src/server.ts` runs the Telegram bot in long-polling mode — there is no HTTP server anywhere in this codebase, and the NAS (`docs/knowledge-base/deploy-and-access.md`) is Tailscale-only with no public IP, domain, or reverse proxy. Meta's webhook APIs require a public HTTPS callback URL reachable from Meta's servers, so this is new infrastructure, not a config tweak.
- **No "Leads" concept exists in Notion today.** The "Instagram"/"Canal de contacto" fields the codebase already has belong to the *Influencer Pipeline* (outbound influencer outreach) and *Content Calendar* (outbound publishing channel) — both unrelated, outbound-shaped DBs. A new Notion DB is needed, wired via the `add-notion-db` skill checklist.

Given the external dependencies (Business Verification, Instagram App Review) are the long pole and outside anyone's direct control, the recommended approach front-loads the Meta-side setup (so the clock starts now) while building the code path in parallel against WhatsApp first (no App Review gate) and testing Instagram in tester mode until Advanced Access lands.

## Recommended approach

### Phase 0 — Meta-side setup (founder/admin actions, not code)

1. Create/verify a Meta Business Portfolio (Business Verification — bring business registration docs; budget 1–6 weeks).
2. Create one Meta App in developers.facebook.com, add the **WhatsApp** and **Instagram** (Messaging) products to it.
3. Enrol the existing WhatsApp number into **Coexistence** via Embedded Signup — confirms the phone app keeps working unchanged.
4. Connect the existing Instagram professional account + its Facebook Page to the app; generate a long-lived Page Access Token.
5. Submit the App Review request for `instagram_business_manage_messages` (Advanced Access) — submit early since this is the long pole; the code side can be built and tested (via WhatsApp, and via Instagram in tester mode) while this is pending.

### Phase 1 — Public HTTPS ingress

Add a minimal HTTP listener to the existing bot process using Node's built-in `http` module (the codebase has no web framework dependency today — `express`/`fastify` would be the only new dependency added, so default to the built-in module unless the handler logic gets complex enough to justify one). Two routes:
- `GET /webhooks/meta` — the verification handshake (echoes `hub.challenge` if `hub.verify_token` matches `META_WEBHOOK_VERIFY_TOKEN`).
- `POST /webhooks/meta` — receives WhatsApp + Instagram event payloads. **Must verify `X-Hub-Signature-256` against `META_APP_SECRET`** before trusting the body (Meta signs every webhook payload; skipping this lets anyone who finds the URL forge lead entries).

Expose it publicly via **Tailscale Funnel** on the existing NAS Tailscale node (`nas-caxias`) — reuses the access model already documented in `deploy-and-access.md`, avoids standing up a new domain/reverse-proxy/TLS cert. Register in `src/server.ts` alongside the existing `bot.start()` call.

### Phase 2 — Classification + Notion write path

New module, e.g. `src/webhooks/meta.ts`:
- Parse inbound WhatsApp/Instagram message payloads (sender id/handle, text, timestamp, channel).
- Dedup on Meta's message id (webhooks can redeliver).
- Classify with a single small Claude Haiku call, following the same pattern as `src/bot/assistant.ts` (model `claude-haiku-4-5-20251001`, prompt in a new `src/prompts/lead-classifier.md`) — a yes/no ("é um pedido de informação / lead?") classification. Only a "yes" gets written to Notion; everything else is dropped, unlogged beyond a debug-level log line.
- On a "yes", write a new Notion **Leads** row via `src/notion.ts`, following the `add-notion-db` skill checklist exactly (steps 1–8): `.env.example` (`NOTION_LEADS_DB_ID`), `LeadRow` in `src/types.ts` (near `PartnerRow`/`InfluencerRow`), schema in `scripts/setup-notion-dbs.mjs`, `NOTION_LEADS_DB_ID` + `initializeDataSources()` + read/write functions (wrapped in `withRetry`, using existing `richText`/rich-text helpers) + both export blocks in `src/notion.ts`, regenerate `docs/notion-db-config.xlsx` via `scripts/gen-notion-config.mjs`.
  - Suggested Leads DB fields: Nome/Handle, Canal (WhatsApp / Instagram — declared statically, not runtime-created, per the skill's option-wiping gotcha), Mensagem, Data, Estado (Novo / Contactado / Convertido / Perdido), Founder responsável (opcional).
- No `create_message`/send capability anywhere in this path — read-only by construction, matching the founder's requirement.

### Phase 3 — Verification

- `npm run typecheck && npm run build && npm run test`.
- Send a real test WhatsApp message (to the coexistence-enabled number) and a test Instagram DM (from an app-tester account, until Advanced Access lands) and confirm: webhook received → signature verified → classified correctly (send one obvious lead-shaped message and one obvious non-lead message, confirm only the former is saved) → Notion row created with correct fields.
- Run the `check-notion-schema` skill with the new Leads DB added to its `EXPECTED` map.
- Deploy per the standard NAS runbook (`npm run build` locally → `docker compose build --no-cache` → `up -d`), and confirm the Tailscale Funnel route survives a container restart.

## Open items to flag to the founder before/alongside implementation

- Business Verification and Instagram App Review are not something engineering can accelerate — worth starting Phase 0 immediately regardless of when the code work starts.
- Classification will not be perfect; expect to tune the prompt/threshold after seeing real traffic for a week or two.
- The current plan is capture-only (Notion database). Surfacing new leads to the founders (e.g. a Telegram digest or `/leads` command) is a natural fast-follow but is out of scope here unless wanted now.
