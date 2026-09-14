# Tidy-mailboxes cron

A real, live-bot cron (`src/crons/tidy-mailboxes.ts`, registered in `src/server.ts`, runs hourly) that keeps configured Outlook shared inboxes tidy: forwards invoice-looking attachments to a dedicated finance address, then archives any remaining thread a Haiku classifier judges resolved.

**Fully automatic — no human review step.** This is the opposite design from the sibling [Outlook partnerships sync](outlook-partnerships-sync.md), which always requires a human to review before writing anything. The two features share `src/lib/outlook.ts` but differ in autonomy for a reason: writing business records to Notion propagates a wrong guess forward, while archiving an email (still exists, still searchable, just out of the Inbox) or forwarding a false-positive "invoice" (mildly annoying, not harmful) are both low-stakes, reversible-in-spirit mistakes. That's the judgment call behind running this unattended — re-litigate it if the failure mode ever turns out worse than that in practice.

## What it does, per configured mailbox

1. Lists whatever's currently in the mailbox's **Inbox folder only** (not the whole mailbox) — this doubles as the to-do queue, since archiving is what removes something from it. No separate checkpoint file to maintain, unlike the partnerships sync.
2. For each message with an attachment: checks whether it's a PDF/image whose filename, or the email's subject/body, mentions fatura/invoice/recibo/receipt (`invoiceAttachments()` in `tidy-mailboxes.ts`). If so: forwards the original message (attachments included) to `OUTLOOK_INVOICES_FORWARD_TO`, then archives it.
3. Everything else: asks `classifyMailboxThread()` (Claude Haiku, `src/bot/classify-mailbox-thread.ts`) whether the thread still needs a reply/action. If not, archives it. If it does, leaves it alone.

## Fail-safe design

The classifier **fails toward `NEEDS_ACTION`** on any error, empty response, or unparseable output — no API key, a network error, a malformed answer, all default to leaving the email where it is rather than risking an archive of something that needed a reply. Read `classify-mailbox-thread.ts`'s `fallback()` calls before changing this — the asymmetry (missed archive = mild annoyance; wrong archive = a customer inquiry silently disappears) is deliberate, not an oversight.

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

Every mutation logs a structured line: `tidy_mailboxes.invoice_forwarded` or `tidy_mailboxes.archived`, each with `mailbox`, `messageId`, `subject`, `from`, and (for archives) the classifier's one-line `reason`. Threads left alone log at `debug` level (`tidy_mailboxes.left_in_inbox`) — not visible in production logs by default, only when `NODE_ENV` isn't `production` (see `src/lib/log.ts`). To review what got archived, search the NAS's Docker logs for `tidy_mailboxes.archived` — see the `nas-logs` skill.

Given this runs unattended, **spot-check the Archive folder occasionally**, especially in the first few weeks — if something wrongly archived turns up, that's a real signal to look at `classify-mailbox-thread.ts`'s system prompt, not just an isolated miss.

## File map

| File | Role |
|---|---|
| `src/lib/outlook.ts` | Shared with the partnerships sync — `listInboxMessages`, `getMessageAttachments`, `archiveMessage`, `forwardMessage` are the additions this feature needed |
| `src/bot/classify-mailbox-thread.ts` | Haiku classifier, fails safe toward NEEDS_ACTION |
| `src/crons/tidy-mailboxes.ts` | The cron itself — invoice detection heuristic, per-message orchestration, structured logging |

## Last touched

2026-09-14 — Initial build. Caught one bug before shipping: the invoice-filename check originally used a `\b`-bounded regex, which misses filenames like `fatura_setembro.pdf` (`_` is a word character in regex, so there's no boundary between "fatura" and "_setembro") — switched to plain substring matching after testing surfaced it.
