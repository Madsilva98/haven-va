# Tidy-mailboxes feedback log

This doc exists because of an explicit founder instruction (2026-09-14): **no code or prompt change gets made from collected feedback without the founder reviewing it here first.** When reviewing accumulated `TidyBot: devia ter arquivado` examples (or any other feedback source for this cron), write findings/hypotheses/proposed fixes as a new entry below — never edit `classify-mailbox-thread.ts` or `tidy-mailboxes.ts` directly from a feedback review. Only make the corresponding code change after the founder has read an entry and given explicit approval.

Each entry: date, the example(s) it covers, a hypothesis (clearly marked as unconfirmed unless verified), a proposed fix if there is one, and a status.

**Status values:** `pending review` (written, founder hasn't looked yet) → `approved` (founder said go ahead — implement it) / `rejected` (founder disagreed — don't implement, note why if given) → `applied` (code change shipped, link the commit).

---

## 2026-09-14 — Initial batch: 7 examples from first real `hello@` run

Status: **pending review**

Founder spot-checked `left_in_inbox` results and flagged 7 threads that should have archived. Full examples already live in [tidy-mailboxes.md § Known false negatives](tidy-mailboxes.md#known-false-negatives--collected-2026-09-14-not-yet-fixed) — not duplicating the raw examples here, just the analysis.

Grouped hypotheses (unconfirmed — nothing below has been verified against the actual email bodies or classifier reasoning):

1. **4 examples (Barre 21 jan, Comprovativo de Morada 29 jan, Alteração de pagamento 1 abr, Aula Marcada 27 abr)** — all a short customer confirmation ("ficou feito" / resolved). Hypothesis: a short reply read without enough surrounding thread context may not give the model enough to see what's being confirmed, so it falls back to NEEDS_ACTION under genuine ambiguity. Proposed fix (not yet approved): check whether `MAX_BODY_CHARS` or the classifier's body-slicing is cutting off the quoted original request that a short reply depends on for context — if so, either stop slicing quoted history for short bodies, or pass more of it through.
2. **1 example (Primeira aula 30 jan)** — customer supplied requested data (phone number) without confirmatory language. Hypothesis: `SYSTEM_INSTRUCTION`'s rule (c) covers "confirming they executed something asked of them" but may not obviously cover "silently provided the requested info." Proposed fix (not yet approved): add this shape as an explicit example in the prompt.
3. **1 example (vanusa@bodi8.com, "Partnership")** — should have been caught by the separate `sync-partnerships` keyword scan, not this cron. No hypothesis yet — needs investigation of scan date range / whether it landed in `possible_match` unreviewed, not a guess.
4. **1 example (Mama Baby Walks, 27 março)** — founder says still not archived; logs show it WAS forwarded+archived in the 2026-09-14 backfill. Discrepancy unexplained — needs a direct Graph lookup (like the PUANI case) before assuming either a client-sync-lag issue or a genuine second unarchived message in the same thread.

**Nothing here has been implemented.** Waiting on founder review before touching `classify-mailbox-thread.ts` or `tidy-mailboxes.ts` based on any of the above.
