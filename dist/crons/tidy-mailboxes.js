/**
 * Fully automatic mailbox tidying for configured Outlook shared inboxes
 * (e.g. geral@, hello@): forwards invoice-looking attachments to a
 * dedicated finance address, then archives any remaining thread that a
 * Haiku classifier judges resolved / not needing a reply.
 *
 * No human review step — this is deliberately unattended (unlike the
 * Outlook partnerships sync, which always requires review before writing
 * anything). See docs/knowledge-base/tidy-mailboxes.md for the design,
 * the fail-safe defaults, and how to audit what it's done.
 *
 * Unread messages are untouched entirely — no classification, no invoice
 * forward, no category tag — until a human has actually opened them. Once
 * read, they're picked up fresh on the very next run.
 *
 * A founder can apply the "TidyBot: devia ter arquivado" Outlook category
 * directly to a message the classifier missed — no Claude Code needed. The
 * next run archives it immediately and logs the full content under
 * tidy_mailboxes.feedback_should_have_archived, building a record of real
 * misses to refine the classifier prompt against later.
 *
 * Gracefully disabled if OUTLOOK_TIDY_MAILBOXES or the Microsoft/Outlook
 * env vars aren't set — same pattern as every other optional feature here.
 *
 * Set TIDY_MAILBOXES_DRY_RUN=true to run the full classification/detection
 * logic against real mailboxes without actually archiving or forwarding —
 * logs tidy_mailboxes.would_archive/would_forward instead. Use this to
 * sanity-check behavior on real inbox content before trusting it live.
 *
 * Cost note: every message left in the Inbox (needs a reply) gets tagged
 * with the TIDY_CATEGORY Outlook category and is skipped on every
 * subsequent run without calling Claude or re-forwarding anything — this
 * cron only ever pays for genuinely new arrivals, not for re-litigating
 * the same still-open thread every single run. On top of that, known
 * pure-notification senders (DEFAULT_AUTO_ARCHIVE_SENDERS, extend via
 * TIDY_MAILBOXES_AUTO_ARCHIVE_SENDERS) skip the Haiku call AND the invoice
 * check entirely — archived on sender match alone.
 *
 * The tag isn't permanent: once the message's lastModifiedDateTime is older
 * than TIDY_MAILBOXES_RECHECK_AFTER_DAYS (default 7), it's treated as due
 * for a fresh look rather than skipped — a "needs action" verdict from a
 * week ago might be stale (e.g. resolved outside email entirely, on a
 * vendor's own platform). Deliberately uses the message's own
 * lastModifiedDateTime rather than a separate state file tracking exactly
 * when we tagged it — simpler, at the accepted cost that ANY touch to the
 * message (a founder opening it, flagging it, adding another category)
 * also resets the clock, so a checked-on-but-still-unresolved thread can
 * go stale for another full week before being reconsidered. That's an
 * accepted trade-off, not a bug — see docs/knowledge-base/tidy-mailboxes.md.
 */
import { classifyMailboxThread } from "../bot/classify-mailbox-thread.js";
import { log } from "../lib/log.js";
import * as outlook from "../lib/outlook.js";
// Tags a message once it's been checked and left in the Inbox (needs a
// reply, or errored and fell back to needs-action) so the next run skips
// it entirely — no re-classification, and critically, no re-forwarding an
// invoice-looking attachment every single run it sits there waiting for a
// human. Without this, the cron re-pays the full LLM cost (and duplicates
// any forward) for every message still open, for as long as it stays open
// — the real cost driver, not the one-time backlog of a first run.
const TIDY_CATEGORY = "TidyBot: revisto";
// A founder applies this Outlook category directly to a message (no Claude
// Code, no Telegram) when they spot one the classifier should have archived
// but didn't. Checked before anything else in the loop: archives the
// message right away (the founder already made the call) and logs the full
// content so a future session can review real misses and refine the
// classifier prompt against them — see docs/knowledge-base/tidy-mailboxes.md.
const FEEDBACK_SHOULD_ARCHIVE_CATEGORY = "TidyBot: devia ter arquivado";
function recheckAfterDays() {
    const raw = Number(process.env.TIDY_MAILBOXES_RECHECK_AFTER_DAYS);
    return Number.isFinite(raw) && raw > 0 ? raw : 7;
}
/** True if the tag is still "fresh" (within the recheck window) and should be skipped. */
function isTagFresh(lastModifiedDateTime) {
    const modified = new Date(lastModifiedDateTime);
    if (Number.isNaN(modified.getTime()))
        return false; // unparseable — treat as stale, re-check rather than skip forever
    const ageDays = (Date.now() - modified.getTime()) / (1000 * 60 * 60 * 24);
    return ageDays < recheckAfterDays();
}
const INVOICE_WORDS = ["fatura", "invoice", "recibo", "receipt"];
// Plain substring matching, not a \b-bounded regex — filenames commonly use
// underscores ("fatura_setembro.pdf"), and \b doesn't count "_" as a
// boundary (it's a word character), so a regex missed exactly the filename
// shape real invoices show up with. Caught by testing before this shipped.
function mentionsInvoice(text) {
    const lower = text.toLowerCase();
    return INVOICE_WORDS.some((w) => lower.includes(w));
}
function isPdfOrImage(contentType) {
    return /^application\/pdf$/i.test(contentType) || /^image\//i.test(contentType);
}
// Only a bill someone sent US should go to faturas@ — an invoice the Haven
// itself sent to a customer (e.g. attached to a reply to "pode enviar-me a
// fatura?") is never something finance needs forwarded, even though it can
// still land in the Inbox (a self-CC, or a shared-mailbox send-as copy).
// Approximated by sender domain: mail from the same domain as the mailbox
// being tidied is treated as sent by the Haven itself, not received.
function isFromOwnDomain(mailbox, fromEmail) {
    const at = mailbox.indexOf("@");
    if (at === -1)
        return false; // "me" — not a domain-based shared mailbox, never the sender-check target
    const ownDomain = mailbox.slice(at + 1).toLowerCase();
    return fromEmail.toLowerCase().endsWith(`@${ownDomain}`);
}
/**
 * Returns the attachment(s) that made this look like an invoice, or null.
 * Requires a PDF/image attachment AND (its filename OR the email's
 * subject/body) mentioning fatura/invoice/recibo/receipt — attachment type
 * alone isn't enough, to avoid forwarding every PDF proposal/contract.
 */
function invoiceAttachments(subject, body, attachments) {
    const candidates = attachments.filter((a) => isPdfOrImage(a.contentType));
    if (candidates.length === 0)
        return null;
    const nameMatch = candidates.some((a) => mentionsInvoice(a.name));
    const contextMatch = mentionsInvoice(subject) || mentionsInvoice(body.slice(0, 1000));
    return nameMatch || contextMatch ? candidates : null;
}
function configuredMailboxes() {
    return (process.env.OUTLOOK_TIDY_MAILBOXES ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
}
// Exact sender addresses known to send nothing but pure logistics
// notifications (never an invoice, never anything actionable) — skips both
// the invoice check and the Haiku call entirely for these. Deliberately
// exact addresses, not whole domains: a domain like amazon.es also sends
// account/billing mail that might need a look, but its dedicated shipping-
// notification addresses (confirmar-envio@, auto-confirm@) never do.
// Extend via TIDY_MAILBOXES_AUTO_ARCHIVE_SENDERS, comma-separated.
const DEFAULT_AUTO_ARCHIVE_SENDERS = [
    "no-reply@notifications.cttexpress.com",
    "no-reply@cttexpresso.pt",
    "no-reply@correosexpress.com",
    "no-reply@sendcloud.com",
    "noreply@gls-portugal.com",
    "confirmar-envio@amazon.es",
    "auto-confirm@amazon.es",
    "devolucion@amazon.es",
    // Wellhub's dedicated marketing/nurture-drip addresses — every message
    // seen from these is an automated signup nag ("assinatura", "contrato
    // pronto", "falta pouco para ativar", etc.), unlike support@wellhub.com
    // which also carries the real partnership negotiation thread. Subject
    // keyword matching (AUTO_ARCHIVE_RULES below) missed several of these
    // because the wording varies ("assine" vs "assinatura" vs no sign-related
    // word at all) — sender-address matching is more robust here than trying
    // to enumerate every phrasing.
    "partners.signup@wellhub.com",
    "globalpartners@email.wellhub.com",
];
function autoArchiveSenders() {
    const extra = (process.env.TIDY_MAILBOXES_AUTO_ARCHIVE_SENDERS ?? "")
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
    return new Set([...DEFAULT_AUTO_ARCHIVE_SENDERS, ...extra]);
}
// Sender+subject combo rules — for senders that ALSO send things that
// genuinely need a look (e.g. support@wellhub.com sends both these signup
// nags AND the real Wellhub partnership negotiation thread), so the sender
// alone isn't a safe enough signal — the subject narrows it to only the
// specific automated pattern. All conditions in a rule must match (sender
// AND subject); any one rule matching is enough to archive.
const AUTO_ARCHIVE_RULES = [
    {
        description: "Wellhub/ClassPass automated signup reminder",
        senderContainsAny: ["wellhub.com", "gympass.com", "classpass.com"],
        subjectContainsAny: ["assine"],
    },
    {
        description: "Kenko Luna approvals pending notification",
        senderContainsAny: ["bookeeapp.com"],
        subjectContainsAny: ["luna approvals pending"],
    },
    {
        description: "Kenko AI new-message notification",
        senderContainsAny: ["bookeeapp.com"],
        subjectContainsAny: ["new message from"],
    },
];
function matchingAutoArchiveRule(fromEmail, subject) {
    const from = fromEmail.toLowerCase();
    const subj = subject.toLowerCase();
    for (const rule of AUTO_ARCHIVE_RULES) {
        const senderMatch = rule.senderContainsAny.some((s) => from.includes(s.toLowerCase()));
        const subjectMatch = rule.subjectContainsAny.some((s) => subj.includes(s.toLowerCase()));
        if (senderMatch && subjectMatch)
            return rule;
    }
    return null;
}
function isDryRun() {
    return process.env.TIDY_MAILBOXES_DRY_RUN === "true";
}
/**
 * Classification ALWAYS runs, and is the only thing that decides whether
 * the original stays in the Inbox — an invoice-looking attachment never
 * bypasses it. Forwarding a copy to finance and archiving the original are
 * independent decisions: a customer complaint that happens to attach a
 * receipt still gets forwarded (finance gets their copy) but is NOT
 * archived, because it still needs a reply.
 *
 * This wasn't the original design — a first version treated "has an
 * invoice attachment" as a shortcut that skipped classification entirely
 * and always archived. A dry run against real mailboxes caught it
 * archiving a customer's "Issues with 10 day pass" complaint and a
 * contract awaiting signature, both because they happened to have a PDF
 * attached. Fixed 2026-09-14 before this ever ran for real — see
 * docs/knowledge-base/tidy-mailboxes.md.
 */
async function handleMessage(mailbox, msg, forwardTo, latestSentByConversation) {
    const dryRun = isDryRun();
    const outcome = { forwarded: false, archived: false, autoArchived: false };
    if (autoArchiveSenders().has(msg.from.email.toLowerCase())) {
        if (!dryRun) {
            await outlook.archiveMessage(mailbox, msg.id);
        }
        log.info(dryRun ? "tidy_mailboxes.would_auto_archive" : "tidy_mailboxes.auto_archived", {
            mailbox,
            messageId: msg.id,
            subject: msg.subject,
            from: msg.from.email,
            rule: "exact sender match",
        });
        outcome.archived = true;
        outcome.autoArchived = true;
        return outcome;
    }
    const matchedRule = matchingAutoArchiveRule(msg.from.email, msg.subject);
    if (matchedRule) {
        if (!dryRun) {
            await outlook.archiveMessage(mailbox, msg.id);
        }
        log.info(dryRun ? "tidy_mailboxes.would_auto_archive" : "tidy_mailboxes.auto_archived", {
            mailbox,
            messageId: msg.id,
            subject: msg.subject,
            from: msg.from.email,
            rule: matchedRule.description,
        });
        outcome.archived = true;
        outcome.autoArchived = true;
        return outcome;
    }
    if (msg.hasAttachments && !isFromOwnDomain(mailbox, msg.from.email)) {
        const attachments = await outlook.getMessageAttachments(mailbox, msg.id);
        const matched = invoiceAttachments(msg.subject, msg.body, attachments);
        if (matched) {
            if (!dryRun) {
                await outlook.forwardMessage(mailbox, msg.id, [forwardTo], "Reencaminhado automaticamente (parece conter uma fatura).");
            }
            log.info(dryRun ? "tidy_mailboxes.would_forward" : "tidy_mailboxes.invoice_forwarded", {
                mailbox,
                messageId: msg.id,
                subject: msg.subject,
                from: msg.from.email,
                attachment: matched.map((a) => a.name).join(", "),
                forwardedTo: forwardTo,
            });
            outcome.forwarded = true;
        }
    }
    // If the Haven has already replied more recently than this message
    // arrived, classify using OUR reply's content instead of the original —
    // a customer's Inbox message never updates itself with a later outbound
    // reply, so classifying it in isolation would see an unanswered request
    // forever, even when Sent Items shows it was answered days ago. Only
    // relevant when the customer never wrote back again (their next inbound
    // message would already quote our reply and get classified on its own).
    const latestReply = msg.conversationId
        ? latestSentByConversation.get(msg.conversationId)
        : undefined;
    const supersededByReply = Boolean(latestReply && new Date(latestReply.sentDateTime) > new Date(msg.receivedDateTime));
    const classifyTarget = supersededByReply && latestReply ? latestReply : msg;
    const { needsAction, reason } = await classifyMailboxThread({
        mailbox,
        subject: classifyTarget.subject,
        fromName: classifyTarget.from.name,
        fromEmail: classifyTarget.from.email,
        body: classifyTarget.body,
    });
    if (needsAction) {
        if (!dryRun && !msg.categories.includes(TIDY_CATEGORY)) {
            await outlook.setMessageCategories(mailbox, msg.id, [...msg.categories, TIDY_CATEGORY]);
        }
        log.debug("tidy_mailboxes.left_in_inbox", {
            mailbox,
            messageId: msg.id,
            subject: msg.subject,
            reason,
            classifiedFromReply: supersededByReply,
        });
        return outcome;
    }
    if (!dryRun) {
        await outlook.archiveMessage(mailbox, msg.id);
    }
    log.info(dryRun ? "tidy_mailboxes.would_archive" : "tidy_mailboxes.archived", {
        mailbox,
        messageId: msg.id,
        subject: msg.subject,
        from: msg.from.email,
        reason,
        classifiedFromReply: supersededByReply,
    });
    outcome.archived = true;
    return outcome;
}
export async function run() {
    const mailboxes = configuredMailboxes();
    const forwardTo = process.env.OUTLOOK_INVOICES_FORWARD_TO;
    if (mailboxes.length === 0) {
        log.debug("tidy_mailboxes.disabled", { reason: "OUTLOOK_TIDY_MAILBOXES not set" });
        return;
    }
    if (!forwardTo) {
        log.warn("tidy_mailboxes.disabled", { reason: "OUTLOOK_INVOICES_FORWARD_TO not set" });
        return;
    }
    if (!outlook.isAuthenticated()) {
        log.warn("tidy_mailboxes.disabled", { reason: "outlook not authenticated" });
        return;
    }
    const counts = {
        forwarded: 0,
        archived: 0,
        autoArchived: 0,
        left: 0,
        skipped: 0,
        unread: 0,
        rechecked: 0,
        feedbackArchived: 0,
        errors: 0,
    };
    for (const mailbox of mailboxes) {
        let messages;
        try {
            messages = await outlook.listInboxMessages(mailbox);
        }
        catch (err) {
            log.error("tidy_mailboxes.list_failed", {
                mailbox,
                message: err instanceof Error ? err.message : String(err),
            });
            counts.errors++;
            continue;
        }
        // Non-fatal if this fails — worst case we just lose the "already
        // replied via Sent Items" optimization for this run and classify
        // messages in isolation as before, not skip the mailbox entirely.
        const latestSentByConversation = new Map();
        try {
            const sent = await outlook.listSentMessages(mailbox);
            for (const s of sent) {
                if (!s.conversationId)
                    continue;
                const existing = latestSentByConversation.get(s.conversationId);
                if (!existing || new Date(s.sentDateTime) > new Date(existing.sentDateTime)) {
                    latestSentByConversation.set(s.conversationId, s);
                }
            }
        }
        catch (err) {
            log.warn("tidy_mailboxes.sent_list_failed", {
                mailbox,
                message: err instanceof Error ? err.message : String(err),
            });
        }
        for (const msg of messages) {
            // A founder's explicit "this should have archived" override — checked
            // before anything else, including the unread-skip, since applying the
            // category IS a human having looked at it. Archives immediately and
            // logs the full content for later review, then moves on: no
            // classification, no invoice check, no tag-freshness logic applies.
            if (msg.categories.includes(FEEDBACK_SHOULD_ARCHIVE_CATEGORY)) {
                log.info("tidy_mailboxes.feedback_should_have_archived", {
                    mailbox,
                    messageId: msg.id,
                    subject: msg.subject,
                    from: msg.from.email,
                    receivedDateTime: msg.receivedDateTime,
                    webLink: msg.webLink,
                    bodyPreview: msg.bodyPreview,
                });
                try {
                    if (!isDryRun()) {
                        await outlook.archiveMessage(mailbox, msg.id);
                    }
                    counts.feedbackArchived++;
                }
                catch (err) {
                    log.error("tidy_mailboxes.feedback_archive_failed", {
                        mailbox,
                        messageId: msg.id,
                        message: err instanceof Error ? err.message : String(err),
                    });
                    counts.errors++;
                }
                continue;
            }
            // Untouched until a human has actually opened it — no classification,
            // no invoice-forward, no tag. Once read, it's picked up
            // fresh on the next run like any other message. This is deliberate:
            // archiving (or even just judging) something nobody has seen yet is a
            // different, riskier thing than archiving something a founder already
            // looked at, even if an LLM would judge the content the same either way.
            if (!msg.isRead) {
                counts.unread++;
                continue;
            }
            const isTagged = msg.categories.includes(TIDY_CATEGORY);
            if (isTagged && isTagFresh(msg.lastModifiedDateTime)) {
                counts.skipped++;
                continue;
            }
            if (isTagged) {
                // Tag is stale (message hasn't been modified — by us or anyone
                // else — in over TIDY_MAILBOXES_RECHECK_AFTER_DAYS) — don't skip,
                // but count it separately so the summary shows how much of a run's
                // work is a re-check vs. a genuinely new message.
                counts.rechecked++;
            }
            try {
                const outcome = await handleMessage(mailbox, msg, forwardTo, latestSentByConversation);
                if (outcome.forwarded)
                    counts.forwarded++;
                if (outcome.autoArchived)
                    counts.autoArchived++;
                else if (outcome.archived)
                    counts.archived++;
                if (!outcome.archived)
                    counts.left++;
            }
            catch (err) {
                log.error("tidy_mailboxes.message_failed", {
                    mailbox,
                    messageId: msg.id,
                    subject: msg.subject,
                    message: err instanceof Error ? err.message : String(err),
                });
                counts.errors++;
            }
        }
    }
    log.info("tidy_mailboxes.done", { mailboxes, dryRun: isDryRun(), ...counts });
}
