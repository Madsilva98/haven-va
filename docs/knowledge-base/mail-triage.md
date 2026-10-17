# Mail-triage cron

`src/crons/mail-triage.ts`, daily at 07:00 Europe/Lisbon. **One** pass over the Outlook mailboxes that does, per email and in this order:

1. **Record** partners, influencers and suppliers in Notion.
2. **Forward** to the right address.
3. **Clean** the shared inboxes.

It replaced two crons on 2026-09-30 (founder's call: "we need to make them both work together, not have it read archived emails and just spend money for no reason"):

- **`tidy-mailboxes`** (daily): archived resolved threads in geral@/hello@ and forwarded supplier invoices.
- **`sync-partnerships`** (weekly, Monday): recorded partners/influencers/suppliers in Notion. It never read the Archive folder, so anything `tidy-mailboxes` archived first never reached Notion. That's what happened with the Fit4Life/Stages supplier negotiation (2026-09-29). A partner email in geral@ was also classified by both, so it was paid for twice.

The old docs [tidy-mailboxes.md](tidy-mailboxes.md) and [outlook-partnerships-sync.md](outlook-partnerships-sync.md) still hold the history behind every rule below. The rules were carried over, not reinvented.

## Scope (founder decisions, 2026-09-30)

| Mailboxes | Record in Notion | Forward | Clean (archive) |
|---|---|---|---|
| `OUTLOOK_TIDY_MAILBOXES` (geral@, hello@) | yes | yes | **yes**, Inbox only, read mail only |
| `me` + the rest of `OUTLOOK_MAILBOXES` ("personal") | yes | yes | **never** |

- **Daily** for everything, including recording (it used to be weekly).
- **Unread mail is recorded and forwarded, but never archived.**
- **Forwards**, each at most once:
  - `parceiro` → `OUTLOOK_PARTNERSHIP_FORWARD_TO` (partners@), from any mailbox.
  - `fornecedor` found in a personal mailbox → `OUTLOOK_SUPPLIERS_FORWARD_TO` (geral@). Not from geral@/hello@ themselves.
  - `candidatura` (job/instructor application) → `OUTLOOK_STAFF_FORWARD_TO`. Forwarded only, never recorded anywhere.
  - Supplier invoice in a clean inbox → `OUTLOOK_INVOICES_FORWARD_TO` (faturas@).
  - Each unset target just disables that forward.

## Per email

1. **One AI verdict** (`src/lib/mail-verdict.ts`, prompt `src/prompts/mail-triage.md`, Claude Haiku) returns JSON with `tipo` (PARCEIRO/INFLUENCER/FORNECEDOR/CANDIDATURA/CLIENTE/OUTRO), `fatura_fornecedor` and `precisa_acao`. It merges three older prompts (thread resolution incl. the open-negotiation rule, partnership intent, supplier-invoice gate) and adds CANDIDATURA.
   - No AI call for: known noise senders (`src/lib/mail-rules.ts`); a known contact matched by exact email outside the clean inboxes (the pipeline tells us the type); anything already decided.
   - **An unusable answer means undecided:** nothing is recorded, forwarded or archived, the watermark stops at that email, and it's retried next run.
2. **Record** (`src/lib/mail-record.ts`, moved unchanged from sync-partnerships):
   - An exact-email known contact → update (Último contacto + enrichment).
   - Otherwise, for parceiro/influencer/fornecedor: skip internal-only forwards (never name a page after a founder), dedup by fuzzy name or domain hint (skip, never merge), then create + enrich. A domain match is only ever a dedup hint.
   - Fornecedores is skipped gracefully without `NOTION_SUPPLIER_DB_ID`.
3. **Forward.**
   - Partner/supplier/application forwards:
     - only for mail received **after the cron first went live** (`state.forwardSince`), so the first run doesn't forward the whole backlog;
     - only when the sender is outside the Haven's own domains;
     - **write-ahead** in the state file, so a failed state write means no forward, never a repeat.
   - Invoices keep the permanent Outlook categories `TidyBot: fatura enviada` / `não é fatura` (marker written before forwarding), and both the keyword pre-filter (`src/lib/invoice-detection.ts`) and the verdict must agree.
4. **Clean** (clean inboxes, Inbox folder only):
   - `TidyBot: não arquivar` on any message of the thread → never archived or tagged. It wins over everything. Recording and forwarding copies still happen, because they don't move the email.
   - `TidyBot: devia ter arquivado` → archived straight away (even unread), logged as `mail_triage.feedback_should_have_archived` (the founder feedback loop).
   - Unread → left alone.
   - Noise sender → archived, no AI.
   - Pending (`precisa_acao`, including every open negotiation) → left and tagged `TidyBot: revisto`.
   - Otherwise archived, up to `TIDY_MAILBOXES_MAX_ARCHIVES_PER_RUN` (30) per inbox per run. Over the cap: untouched and untagged for next run.
   - **Re-verdict** happens when the stored verdict is older than `TIDY_MAILBOXES_RECHECK_AFTER_DAYS` (7), or when a newer Haven reply appears in Sent Items (then judged on that reply). Our own auto-forwards are recognised by the "Reencaminhado automaticamente" marker (plus faturas@) and never count as a reply. Not by "addressed to a forward target", because geral@ is now a target and genuine replies go to it.

## State

`DATA_DIR/mail-triage-state.json`:

- `forwardSince`: the go-live cutoff.
- `mailboxWatermarks`: as the old sync. Advances to the newest email seen, unless one failed, in which case it stops at that email.
- `messages`: keyed by a hash of mailbox+id, the same hash as the old sync. Holds the verdict, `recorded`, `forwardedTo`, and `notInvoiceByKeywords`.

On the first run it is **seeded from `partnerships-sync-state.json`**, so everything the old sync already recorded is skipped and its watermarks are reused. Delete neither file by hand.

## Operating

- **Dry run:** `MAIL_TRIAGE_DRY_RUN=true` runs everything including the AI calls but writes nothing (no Notion, forward, archive, category or state file) and logs `mail_triage.would_record` / `would_forward` / `would_archive`. Do this once on the NAS before the first real run:
  ```bash
  ssh haven-nas "sudo -n /usr/local/bin/docker exec -e MAIL_TRIAGE_DRY_RUN=true haven-va-haven-va-1 node --input-type=module -e \\"const m = await import('./dist/crons/mail-triage.js'); await m.run();\\""
  ```
- **Logs:** `mail_triage.done` carries per-run counts (`classified`, `record_*`, `forward_*`, `archived`, `left`, `capped`, `kept_by_founder`, `undecided`, ...). Search for `mail_triage.undecided` / `record_failed` / `forward_failed` / `clean_failed` when something looks off.
- **Cost:** one Haiku call per new email, plus a re-check call for threads still open after 7 days or when a newer reply arrives. Before, a partner email in a shared inbox cost two calls, and an invoice-looking one three.
- `scripts/dry-run-sync-partnerships.mjs` and the manual `scan-outlook-partnerships.mjs` / `apply-outlook-findings.mjs` flow still exist as the old sync's audit tools. They don't know about mail-triage.
