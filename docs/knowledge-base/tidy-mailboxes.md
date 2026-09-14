# Tidy-mailboxes cron

A real, live-bot cron (`src/crons/tidy-mailboxes.ts`, registered in `src/server.ts`, runs daily at 07:00 Europe/Lisbon — changed from an initial hourly cadence on 2026-09-14, since daily is plenty for inbox tidying and cuts the LLM/API call volume) that keeps configured Outlook shared inboxes tidy: forwards invoice-looking attachments to a dedicated finance address, then archives any remaining thread a Haiku classifier judges resolved.

**Fully automatic — no human review step.** This is the opposite design from the sibling [Outlook partnerships sync](outlook-partnerships-sync.md), which always requires a human to review before writing anything. The two features share `src/lib/outlook.ts` but differ in autonomy for a reason: writing business records to Notion propagates a wrong guess forward, while archiving an email (still exists, still searchable, just out of the Inbox) or forwarding a false-positive "invoice" (mildly annoying, not harmful) are both low-stakes, reversible-in-spirit mistakes. That's the judgment call behind running this unattended — re-litigate it if the failure mode ever turns out worse than that in practice.

## What it does, per configured mailbox

1. Lists whatever's currently in the mailbox's **Inbox folder only** (not the whole mailbox) — this doubles as the to-do queue, since archiving is what removes something from it.
2. **Skips anything still unread, entirely** — no classification, no invoice-forward, no category tag. A founder has to have actually opened a message before the bot will touch it at all. Once read, it's picked up fresh on the very next run. This is deliberate: judging and archiving something nobody has seen yet is a different, riskier thing than archiving something a founder already looked at, even if an LLM would reach the same content judgment either way.
3. Skips anything already tagged with the `TidyBot: revisto` category (see Cost design below) — no re-work for a message a previous run already looked at and left alone.
4. **Auto-archive fast path**, two forms — both skip the invoice check and the Haiku call entirely:
   - Exact sender match in `DEFAULT_AUTO_ARCHIVE_SENDERS` (extend via `TIDY_MAILBOXES_AUTO_ARCHIVE_SENDERS`) — known pure logistics-notification addresses (couriers, Amazon's dedicated shipping-confirmation senders).
   - Sender-domain + subject combo in `AUTO_ARCHIVE_RULES` (code-only, no env var — extend by editing `tidy-mailboxes.ts`) — for senders that ALSO send things needing a real look, so the sender alone isn't a safe signal. E.g. `support@wellhub.com` sends both automated "assine agora" signup nags AND the real Wellhub partnership negotiation thread — the rule requires the subject to contain "assine" too, not just the sender domain. Current rules: Wellhub/ClassPass/Gympass signup reminders (subject contains "assine"), Kenko's "Luna approvals pending" and "you've got a new message from" automated notifications (both from `bookeeapp.com`, Kenko's underlying notification sender — a different domain than their `gokenko.com` support addresses).
5. Otherwise, **classification always runs first** (`classifyMailboxThread()`, Claude Haiku, `src/bot/classify-mailbox-thread.ts`) to decide whether the thread still needs a reply. This is the *only* thing that decides whether the original gets archived.
6. Independently of that: if the message has a PDF/image attachment whose filename, or the email's subject/body, mentions fatura/invoice/recibo/receipt (`invoiceAttachments()`), a copy is forwarded to `OUTLOOK_INVOICES_FORWARD_TO` — **regardless of the classification result.** A customer complaint that happens to attach a receipt still gets forwarded (finance gets their copy) but is NOT archived, because it still needs a reply.
7. If the classifier said the thread doesn't need action: archived. If it does: left in the Inbox and tagged `TidyBot: revisto` so future runs skip it without re-paying for the same judgment.

**Steps 4 and 5 were NOT originally independent** — a first version treated a matched invoice attachment as a shortcut that skipped classification entirely and always archived. A dry run against real mailboxes (before this ever ran for real) caught it archiving a customer's "Issues with 10 day pass" complaint and a contract awaiting signature, both because they happened to have a PDF attached. Never reintroduce that shortcut — classification must always run, no matter what the attachment looks like.

## Fail-safe design

The classifier **fails toward `NEEDS_ACTION`** on any error, empty response, or unparseable output — no API key, a network error, a malformed answer, all default to leaving the email where it is rather than risking an archive of something that needed a reply. Read `classify-mailbox-thread.ts`'s `fallback()` calls before changing this — the asymmetry (missed archive = mild annoyance; wrong archive = a customer inquiry silently disappears) is deliberate, not an oversight.

## Cost design

A cron that reclassified everything still sitting in the Inbox every single run would re-pay the full LLM cost — and re-forward any invoice attachment — for every message still open, for as long as it stays open. Mitigations, cheapest-first:

- **Unread skip**: untouched entirely until a human opens it — no LLM call, no forward, no tag (see below).
- **Category-based memory, with expiry**: once a message is classified as needing action (or the classifier errors and fails safe), it's tagged with a dated Outlook category, `TidyBot: revisto YYYY-MM-DD` (`outlook.setMessageCategories()`). Future runs skip it — no re-classification, no re-forward — **as long as the tag is younger than `TIDY_MAILBOXES_RECHECK_AFTER_DAYS`** (default 7). Once older, it's treated as due for a fresh look instead of skipped forever: a week-old "needs action" verdict might be stale — e.g. resolved entirely outside email, on a vendor's own platform, which nothing else would ever prompt a re-check for. A reply to the thread is a *new* message with no tag regardless, so it always gets fresh judgment immediately, tag-expiry aside.
- **Auto-archive allowlist** (`DEFAULT_AUTO_ARCHIVE_SENDERS`): exact sender addresses that are unambiguously pure notifications (never an invoice, never actionable) skip the LLM call and the invoice check entirely. Deliberately scoped to *exact addresses*, not whole domains — a domain like `amazon.es` also sends account/billing mail that might need a look, but `confirmar-envio@amazon.es` never does. Don't add a domain-wide entry without checking it never also sends real invoices (e.g. `ikea.com` and `leroymerlin.pt` both do — never add those).
- **Auto-archive rules** (`AUTO_ARCHIVE_RULES`): sender-domain + subject combos, for a sender that sends both pure noise and things needing a real look from the same address — the subject substring is what makes it safe. See the file map's example in "What it does" above.

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
- Added category-based skip memory and the sender-allowlist fast path (see Cost design) after noticing an unmitigated cron would re-classify (and re-forward) the same still-open threads indefinitely.
- Changed cadence from hourly to daily (07:00) — inbox tidying doesn't need hourly responsiveness, and daily meaningfully cuts LLM/Graph call volume.
- Went live scoped to `geral@` only (not `hello@` yet), and added an unread-skip rule: a message the cron hasn't seen a founder actually open yet is left completely untouched (no classification, no forward, no tag) regardless of what an LLM would judge about its content.
- Added `AUTO_ARCHIVE_RULES` (sender+subject combo fast path) for Wellhub/ClassPass/Gympass "assine" signup reminders and two Kenko/bookeeapp.com automated notification patterns, requested after seeing real recurring volume (155+ "you've got a new message from" notifications alone in one scan).
- First real (non-dry-run) execution on `geral@` (manually triggered): 111 of ~260 processed messages archived/forwarded, 0 errors. Founder review of the results surfaced two real gaps, both fixed same-day:
  - Several Wellhub signup reminders used "assinatura" (noun) where the `AUTO_ARCHIVE_RULES` subject match only caught "assine" (imperative) — same category of near-miss as the earlier `\b`-regex bug, different word form. Rather than keep enumerating every phrasing, added `partners.signup@wellhub.com` and `globalpartners@email.wellhub.com` to `DEFAULT_AUTO_ARCHIVE_SENDERS` directly — every message seen from these two addresses is an automated nurture/nag email, unlike `support@wellhub.com` which also carries the real negotiation thread.
  - The classifier's "needs action unless the Haven's own reply is last" heuristic wrongly flagged threads where the *other party* confirmed they'd completed a requested action (e.g. Kenko: "we've updated the billing dates as requested") — that's resolved even without a closing "thanks" from the Haven. Reframed the prompt around "is anything actually pending on our side?" rather than "who sent the last message?" — verified against both this real example (now correctly NO_ACTION_NEEDED) and a genuinely-still-open thread (still correctly NEEDS_ACTION, no over-correction).
- Founders also flagged a case the cron genuinely can't know about — a Stripe dispute resolved on Stripe's own platform, not by email — which surfaced a real design gap: a "needs action" tag lasted forever with no way to reconsider it short of a human manually removing it. Fixed by encoding the tag date directly in the category string (`TidyBot: revisto YYYY-MM-DD`, no separate state file) — once older than `TIDY_MAILBOXES_RECHECK_AFTER_DAYS` (default 7), the message is re-evaluated instead of skipped forever. Doesn't solve "resolved outside email" directly, but bounds how long a stale verdict can persist unexamined.
