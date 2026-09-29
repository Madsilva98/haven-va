# Fail-safe audit — 2026-09-29

Triggered by the tidy bot archiving an open Fit4Life/Stages Cycling supplier negotiation (see [tidy-mailboxes-feedback-log.md](tidy-mailboxes-feedback-log.md)). The founder asked for the same kind of fail-safe wherever it's relevant. That means: automation never hides or deletes something still open, uncertainty leads to doing nothing, and a founder can always say "don't touch this".

Scope: every code path that archives, moves or deletes something **without a human clicking a button in that moment**.

## Fixed (PR #34)

| Where | Gap | Fix |
|---|---|---|
| `tidy-mailboxes.ts` | Open negotiations were judged "resolved" once our last reply answered their question | Prompt rule: an open negotiation, quote, contract, partnership or supplier deal is always NEEDS_ACTION until closed or declined |
| `tidy-mailboxes.ts` | No way to say "keep this"; a hand-restored email was re-archived next run | `TidyBot: não arquivar` category (`KEEP_IN_INBOX_CATEGORY`, `src/lib/outlook.ts`) |
| `tidy-mailboxes.ts` | With both tags on a message, "devia ter arquivado" (archive) won | Keep is checked first; doing nothing wins |
| `tidy-mailboxes.ts` | The keep tag protected one message only, so a later untagged reply in the same negotiation could still be archived | Applies per `conversationId` (`keptConversationIds` / `isKeptInInbox`) |
| `sync-partnerships.ts` | `forwardAndArchiveIfConfigured` archived **every** partner/influencer/supplier email it processed, including unread ones and open negotiations, with no override. **Dormant:** `OUTLOOK_PARTNERSHIP_FORWARD_TO` is unset in production (checked 2026-09-29), so nothing was archived. Its comment also wrongly claimed the archive still happens when unset. | Never archives an unread message or a kept thread (the forward, a harmless copy, still happens). Logs `sync_partnerships.archive_skipped`. Comment corrected. The keep set only covers the current run's batch, see the code comment. |

## Founder decisions on the proposals below (2026-09-29), all in PR #34

| # | Decision | What shipped |
|---|---|---|
| 1 churn-risk | **No brake.** Founder: "o pior que pode acontecer se apagar tudo? posso só pedir para correr novamente". A re-run recreates every row the views flag, so the list comes back. What's lost is the hand-set Status (Contactado / A vigiar) and Notas; those can only be recovered from Notion's trash (30 days), page by page. | nothing |
| 2 leads-reconcile | **Brake at 30%.** Founder: re-doing this list is much more work. | `isSuspiciousConversionBatch`: if at least 4 AND more than 30% of open leads look converted in one run, archive none, log `leads_reconcile.conversion_brake_tripped`, and post a pt-PT warning to the group |
| 3 deleteListItem | **Ask.** | `src/lib/pick-match.ts`: deletes only on an exact or single strong match, otherwise lists up to 5 options and asks. The reply now shows the real deleted title. Empty titles no longer match everything. |
| 4 cancelReminder | **Ask.** | Same helper; with several pending reminders containing the text, lists them and asks |
| 5 tidy cap | **OK.** | `TIDY_MAILBOXES_MAX_ARCHIVES_PER_RUN` (default 30 per mailbox per run, LLM-judged archives only). Over the cap: left untagged for the next run, log `tidy_mailboxes.archive_capped`, `capped` in the summary |

Not changed, noted: `checkListItem` ("mark done") uses the same loose any-score match, but it only ticks a checkbox (visible, one click to undo), so it's left as is.

## Proposed — original write-up

1. **`churn-risk.ts`: no circuit breaker on the reconcile sweep.** Every Aberto/Contactado/A vigiar row whose email isn't flagged this week is archived. If the views ever return an empty or partial flag list (a Kenko import glitch or a view regression, both of which have happened in other forms), the whole "Clientes em risco" list, founder notes included, is archived in one run. *Proposal:* if the run would archive more than ~30% of open rows (or flags come back empty while open rows exist), skip the sweep, log `churn_risk.reconcile_suspicious`, and say so in the digest.
2. **`leads-reconcile.ts`: same, for auto-detected conversions.** The 2026-09-16 incident (all open Intro Pack leads mass-archived) was exactly this failure. The root cause was fixed, but nothing stops the next one. *Proposal:* the same circuit breaker (e.g. more than 5 or more than 30% of open leads in one run → archive none, report).
3. **`notion.ts` `deleteListItem` (assistant "remove X from list"):** it deletes the best fuzzy match with **any** score above 0. One shared word is enough, so "tirar leite" could delete "leite de aveia" or an unrelated item sharing a word. *Proposal:* require exact / substring / ≥0.5 word overlap, otherwise reply asking which item.
4. **`notion.ts` `cancelReminder`:** it takes the first unsent reminder whose title *contains* the text (`page_size: 1`). With several matches it cancels an arbitrary one. *Proposal:* if there's more than one match, list them and ask.
5. **`tidy-mailboxes.ts`: no blast-radius cap.** A prompt regression could archive dozens of threads in one unattended run (normal daily volume is about 10). *Proposal:* cap LLM-judged archives at about 30 per mailbox per run; the rest wait for the next run, with a warn log.

## Checked, already fine

- `tidy-mailboxes`: the classifier fails toward NEEDS_ACTION; the invoice gate fails toward *not* forwarding; unread mail is never touched.
- `leads-reconcile` archiving rows the founder set to Perdido/Convertido/Inconclusivo, and `churn-risk` sweeping Resolvido/Arquivado: explicit founder decisions (including the Intro Pack exception), not automation guessing.
- `callbacks.ts` `archivePage`: a founder pressed a button.
- Both "archives" are recoverable: Outlook Archive is a folder, and Notion keeps archived pages in the trash for 30 days.
