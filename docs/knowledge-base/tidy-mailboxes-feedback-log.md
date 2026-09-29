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

---

## 2026-09-28 — Same message forwarded to `faturas@` over and over, and it's a contract, not an invoice

Status: **applied**

Founder approved in chat on 2026-09-28 and added two rules: only supplier invoices (never invoices the studio sends to clients), and never quotes/proposals ("só mesmo faturas"). The offending email was identified as **"Proposta de orçamento" from lipclean.trans@gmail.com**, forwarded more than once. Shipped with a Haiku "supplier bill?" gate (`src/bot/classify-invoice.ts`) on top of the proposals below. See the PR on branch `worktree-tidy-invoice-forward-review`.

Founder report (chat): "está sempre a reencaminhar a mesma mensagem para o faturas, e nem tem faturas, tem tipo contrato." The specific message hasn't been identified: NAS logs only go back to a container restart on 2026-09-28 17:34, and nobody looked it up directly in Graph. The diagnosis below comes from reading the code, not from that email. The *mechanisms* are certain, but which of them hit this particular message is unconfirmed.

### Why the same message is forwarded again (two causes, both certain from the code)

1. **Nothing remembers that a forward happened.** The only "already handled" marker is `TidyBot: revisto`, and it expires. Once the message's `lastModifiedDateTime` is older than `TIDY_MAILBOXES_RECHECK_AFTER_DAYS` (7), the whole `handleMessage()` runs again, invoice forward included. A contract awaiting signature is exactly the kind of thread that sits in the Inbox as NEEDS_ACTION for weeks, so it gets re-forwarded roughly weekly for as long as it stays there. This was never meant to happen: the tag expiry was added so the *classification* could be revisited, and it re-enables the forward as a side effect.
2. **The forward happens before the tag is written.** If anything after the forward throws (`setMessageCategories` failing, for example), the message is never tagged and gets forwarded again on *every* daily run. If the founder is seeing daily rather than weekly repeats, this is the likelier cause (unconfirmed).

### Why a contract counts as an invoice (criteria too loose)

`invoiceAttachments()` forwards if there is **any** PDF/image attachment AND the words `fatura`/`invoice`/`recibo`/`receipt` appear **anywhere** in the attachment name, the subject, **or the first 1,000 characters of the body**. That's plain substring matching, so:
- The body includes quoted thread history. One earlier line like "envio a fatura depois" or "dados de faturação" anywhere in the quoted text is enough.
- `fatura` matches inside `faturação` / `faturar`; `recibo` matches inside `recibos verdes`. A contract or proposal routinely mentions billing terms.
- Nothing ever looks at what the PDF is. `Contrato_Haven.pdf` passes as long as the body mentions billing.

### Related bug found while reading (certain from the code)

The bot's own forward lands in Sent Items **with the same `conversationId`**. On the next check, the "Haven already replied" logic (`latestSentByConversation`) treats our own auto-forward as a real reply and classifies *that* text instead of the customer's message. A contract still awaiting signature could therefore be judged resolved and archived just because the bot forwarded it to finance.

### Proposed fix (not yet approved)

1. **Forward at most once per message.** Right after a successful forward, add a second category, `TidyBot: fatura enviada`, and skip the invoice check entirely for any message that already carries it, regardless of whether `revisto` has expired. Write the category **before** forwarding; if that write fails, don't forward. Missing one forward is recoverable; spamming `faturas@` is not.
2. **Tighten the invoice criteria:**
   - Look at the **attachment filename and the subject only**. Drop the body, since quoted history is the main source of false positives.
   - Match whole words, not substrings: `fatura(s)`, `invoice(s)`, `recibo(s)`, `receipt(s)`, and `FT`/`FR` + number patterns if needed. `faturação` no longer matches. `_` and `-` still count as separators, so `fatura_setembro.pdf` keeps working.
   - **Exclusion list:** if the attachment name or subject contains `contrato`/`contract`/`proposta`/`proposal`/`orçamento`/`quote`/`acordo`/`agreement`, don't forward, even if another criterion matched.
3. **Ignore our own auto-forwards when looking for "the Haven already replied".** Exclude Sent Items messages addressed to `OUTLOOK_INVOICES_FORWARD_TO` or containing the "Reencaminhado automaticamente" comment.

Tests: unit tests for `invoiceAttachments()` covering the contract case, the `faturação` quoted-history case, `fatura_setembro.pdf` (must still match), and a message already carrying `fatura enviada` (must not forward).

---

## 2026-09-29 — Ongoing supplier negotiation archived ("Re: Stages Cycling - Madalena Marques Da Silva - Fit4Life Portugal/España")

Status: **applied** (founder approved 1 and 2 in chat, 2026-09-29: "sim implementa as duas coisas"). The prompt rule is in `classify-mailbox-thread.ts`, and `KEEP_IN_INBOX_CATEGORY` is in `tidy-mailboxes.ts`. One deviation from the proposal: `feedback_keep_in_inbox` logs at debug, not info, because it fires on every run while the tag is on. The summary's `keptByFounder` count is the signal. The prompt rule has NOT been re-run against this exact email (no production mailbox read access from the dev session). Verify on the next dry run.

Archived on the 2026-09-29 07:00 run (`geral@`). Classifier reason: "Madalena respondeu ao formulário da Fit4Life com as informações solicitadas; a negociação prossegue com o fornecedor externo… e não há ação pendente da equipa." Founder: negotiations are still going, so it should NOT have been archived.

**Why it happened (certain from the prompt):** rule (b) in `classify-mailbox-thread.ts` treats "our last message answered what was asked" as resolved. That's right for a customer support question, but wrong for an open commercial conversation (supplier, partner, contract) where we're waiting on the other side's proposal or price. The classifier even *said* the negotiation continues, and still archived it.

**Knock-on effect (certain from the code):** `sync-partnerships` excludes the Archive folder, so this thread will never update the existing Fornecedores row "Stages Cycling" (created 2026-09-22 from the website form-confirmation email, Status "A avaliar", no mention of Fit4Life). This is the "known, flagged-not-fixed risk" in `tidy-mailboxes.md`, now confirmed in production.

**Second gap:** if a founder moves it back to the Inbox by hand, the next run reclassifies it from scratch (it's read and untagged) and will most likely archive it again. There is no "keep this" signal, only the opposite `TidyBot: devia ter arquivado`.

### Proposed fix (not yet approved)
1. **Prompt:** add an explicit NEEDS_ACTION rule. An open commercial conversation (negotiation, quote, proposal, contract, partnership, or supplier deal) where the deal isn't closed or declined yet stays in the Inbox, even if our last message answered their question. Include this exact case as the example.
2. **"Não arquivar" override:** a founder-applied Outlook category `TidyBot: não arquivar`, checked right after the `devia ter arquivado` check. Any message carrying it is never classified, archived, or forwarded, permanently. It's the mirror of the existing feedback loop, and logs `tidy_mailboxes.feedback_keep_in_inbox` so misses accumulate as data.
3. **Not proposed now:** making `sync-partnerships` read the Archive. That was a deliberate choice (see `outlook-partnerships-sync.md`), and 1+2 fix the actual failure.
