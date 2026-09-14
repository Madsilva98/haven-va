# Tidy-mailboxes cron

A real, live-bot cron (`src/crons/tidy-mailboxes.ts`, registered in `src/server.ts`, runs hourly) that keeps configured Outlook shared inboxes tidy: forwards invoice-looking attachments to a dedicated finance address, then archives any remaining thread a Haiku classifier judges resolved.

**Fully automatic — no human review step.** This is the opposite design from the sibling [Outlook partnerships sync](outlook-partnerships-sync.md), which always requires a human to review before writing anything. The two features share `src/lib/outlook.ts` but differ in autonomy for a reason: writing business records to Notion propagates a wrong guess forward, while archiving an email (still exists, still searchable, just out of the Inbox) or forwarding a false-positive "invoice" (mildly annoying, not harmful) are both low-stakes, reversible-in-spirit mistakes. That's the judgment call behind running this unattended — re-litigate it if the failure mode ever turns out worse than that in practice.

## What it does, per configured mailbox

1. Lists whatever's currently in the mailbox's **Inbox folder only** (not the whole mailbox) — this doubles as the to-do queue, since archiving is what removes something from it.
2. Skips anything already tagged with the `TidyBot: revisto` category (see Cost design below) — no re-work for a message a previous run already looked at and left alone.
3. **Auto-archive fast path**: if the sender is an exact match in `DEFAULT_AUTO_ARCHIVE_SENDERS` (extend via `TIDY_MAILBOXES_AUTO_ARCHIVE_SENDERS`) — known pure logistics-notification addresses (couriers, Amazon's dedicated shipping-confirmation senders) — archives immediately. No invoice check, no Haiku call.
4. Otherwise, **classification always runs first** (`classifyMailboxThread()`, Claude Haiku, `src/bot/classify-mailbox-thread.ts`) to decide whether the thread still needs a reply. This is the *only* thing that decides whether the original gets archived.
5. Independently of that: if the message has a PDF/image attachment whose filename, or the email's subject/body, mentions fatura/invoice/recibo/receipt (`invoiceAttachments()`), a copy is forwarded to `OUTLOOK_INVOICES_FORWARD_TO` — **regardless of the classification result.** A customer complaint that happens to attach a receipt still gets forwarded (finance gets their copy) but is NOT archived, because it still needs a reply.
6. If the classifier said the thread doesn't need action: archived. If it does: left in the Inbox and tagged `TidyBot: revisto` so future runs skip it without re-paying for the same judgment.

**Steps 4 and 5 were NOT originally independent** — a first version treated a matched invoice attachment as a shortcut that skipped classification entirely and always archived. A dry run against real mailboxes (before this ever ran for real) caught it archiving a customer's "Issues with 10 day pass" complaint and a contract awaiting signature, both because they happened to have a PDF attached. Never reintroduce that shortcut — classification must always run, no matter what the attachment looks like.

## Fail-safe design

The classifier **fails toward `NEEDS_ACTION`** on any error, empty response, or unparseable output — no API key, a network error, a malformed answer, all default to leaving the email where it is rather than risking an archive of something that needed a reply. Read `classify-mailbox-thread.ts`'s `fallback()` calls before changing this — the asymmetry (missed archive = mild annoyance; wrong archive = a customer inquiry silently disappears) is deliberate, not an oversight.

## Cost design

An hourly cron that reclassified everything still sitting in the Inbox every single run would re-pay the full LLM cost — and re-forward any invoice attachment — for every message still open, for as long as it stays open. Two mitigations:

- **Category-based memory**: once a message is classified as needing action (or the classifier errors and fails safe), it's tagged with the Outlook category `TidyBot: revisto` (`outlook.setMessageCategories()`). Future runs skip anything already carrying that tag entirely — no re-classification, no re-forward. A reply to the thread is a *new* message with no tag, so it still gets fresh judgment; the stale original just sits there, correctly ignored.
- **Auto-archive allowlist**: exact sender addresses that are unambiguously pure notifications (never an invoice, never actionable) skip the LLM call and the invoice check entirely. Deliberately scoped to *exact addresses*, not whole domains — a domain like `amazon.es` also sends account/billing mail that might need a look, but `confirmar-envio@amazon.es` never does. Don't add a domain-wide entry without checking it never also sends real invoices (e.g. `ikea.com` and `leroymerlin.pt` both do — never add those).

## Setup

### 1. Additional Graph permissions (beyond the partnerships sync's read-only ones)

The partnerships sync only needed `Mail.Read`/`Mail.Read.Shared`. This cron mutates mailboxes, so the same Azure app registration needs more, added the same way as the original setup (App registrations → the app → API permissions → Add a permission → Microsoft Graph → Delegated permissions → Grant admin consent):

- `Mail.ReadWrite` + `Mail.ReadWrite.Shared` — to move messages to Archive
- `Mail.Send` + `Mail.Send.Shared` — to forward messages

**A token issued before these scopes were added won't have them.** `src/lib/outlook.ts`'s `SCOPES` constant lists everything now requested at auth time, but the *stored* refresh token only carries what was consented when it was issued — re-run `node scripts/outlook-auth.mjs` after this change lands, even if `outlook-tokens.json` already exists.

Also verify (with whoever administers Exchange) that the authenticated account has **Send-As or Send-on-Behalf** permission on each mailbox in `OUTLOOK_TIDY_MAILBOXES` — this is separate from the Full Access permission the partnerships sync needed for reading, and without it `forwardMessage()`/`archiveMessage()` will 403 the same way a missing Full Access grant would 403 a read.

### 2. Env vars

```
OUTLOOK_TIDY_MAILBOXES=geral@dominio.com,hello@dominio.com
OUTLOOK_INVOICES_FORWARD_TO=faturas@dominio.com
```

Both must be set (and Outlook authenticated) or the cron logs `tidy_mailboxes.disabled` and no-ops — same graceful-disable convention as every other optional feature.

### 3. Deploy

This is a normal cron in `src/server.ts` now — no special deploy step, just the usual `npm run build` + `docker compose build --no-cache && up -d`. Unlike the partnerships-sync scripts, this needs to actually be running in the **production container**, not just locally — the token file (`DATA_DIR/outlook-tokens.json`) and env vars need to be present in the NAS's `.env`, not only your local `.env.local`.

## Auditing what it's done

Every mutation logs a structured line: `tidy_mailboxes.invoice_forwarded`, `tidy_mailboxes.archived`, or `tidy_mailboxes.auto_archived` (the sender-allowlist fast path), each with `mailbox`, `messageId`, `subject`, `from`, and (for LLM-judged archives) the classifier's one-line `reason`. Threads left alone log at `debug` level (`tidy_mailboxes.left_in_inbox`) — not visible in production logs by default, only when `NODE_ENV` isn't `production` (see `src/lib/log.ts`). To review what got archived, search the NAS's Docker logs for `tidy_mailboxes.archived` or `tidy_mailboxes.auto_archived` — see the `nas-logs` skill. The final `tidy_mailboxes.done` summary line per run breaks counts down as `forwarded`/`archived`/`autoArchived`/`left`/`skipped`/`errors`.

Given this runs unattended, **spot-check the Archive folder occasionally**, especially in the first few weeks — if something wrongly archived turns up, that's a real signal to look at `classify-mailbox-thread.ts`'s system prompt, not just an isolated miss.

## File map

| File | Role |
|---|---|
| `src/lib/outlook.ts` | Shared with the partnerships sync — `listInboxMessages`, `getMessageAttachments`, `archiveMessage`, `forwardMessage`, `setMessageCategories` are the additions this feature needed |
| `src/bot/classify-mailbox-thread.ts` | Haiku classifier, fails safe toward NEEDS_ACTION |
| `src/crons/tidy-mailboxes.ts` | The cron itself — invoice detection heuristic, per-message orchestration, structured logging |

## Last touched

2026-09-14 — Initial build, then hardened based on a real dry run against `geral@`/`hello@` before ever running for real:
- Invoice-filename check originally used a `\b`-bounded regex, which misses filenames like `fatura_setembro.pdf` (`_` is a word character in regex, so there's no boundary between "fatura" and "_setembro") — switched to plain substring matching.
- Invoice detection originally skipped classification entirely and always archived — wrongly archived a customer complaint and a contract awaiting signature that happened to have a PDF attached. Decoupled: classification always runs, forwarding a copy to finance is independent of the archive decision.
- Added category-based skip memory and the sender-allowlist fast path (see Cost design) after noticing an unmitigated hourly cron would re-classify (and re-forward) the same still-open threads indefinitely.
