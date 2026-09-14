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
 * Gracefully disabled if OUTLOOK_TIDY_MAILBOXES or the Microsoft/Outlook
 * env vars aren't set — same pattern as every other optional feature here.
 */
import { classifyMailboxThread } from "../bot/classify-mailbox-thread.js";
import { log } from "../lib/log.js";
import * as outlook from "../lib/outlook.js";
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
async function handleMessage(mailbox, msg, forwardTo) {
    if (msg.hasAttachments) {
        const attachments = await outlook.getMessageAttachments(mailbox, msg.id);
        const matched = invoiceAttachments(msg.subject, msg.body, attachments);
        if (matched) {
            await outlook.forwardMessage(mailbox, msg.id, [forwardTo], "Reencaminhado automaticamente (parece conter uma fatura).");
            await outlook.archiveMessage(mailbox, msg.id);
            log.info("tidy_mailboxes.invoice_forwarded", {
                mailbox,
                messageId: msg.id,
                subject: msg.subject,
                from: msg.from.email,
                attachment: matched.map((a) => a.name).join(", "),
                forwardedTo: forwardTo,
            });
            return "forwarded";
        }
    }
    const { needsAction, reason } = await classifyMailboxThread({
        mailbox,
        subject: msg.subject,
        fromName: msg.from.name,
        fromEmail: msg.from.email,
        body: msg.body,
    });
    if (needsAction) {
        log.debug("tidy_mailboxes.left_in_inbox", {
            mailbox,
            messageId: msg.id,
            subject: msg.subject,
            reason,
        });
        return "left";
    }
    await outlook.archiveMessage(mailbox, msg.id);
    log.info("tidy_mailboxes.archived", {
        mailbox,
        messageId: msg.id,
        subject: msg.subject,
        from: msg.from.email,
        reason,
    });
    return "archived";
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
    const counts = { forwarded: 0, archived: 0, left: 0, errors: 0 };
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
        for (const msg of messages) {
            try {
                const outcome = await handleMessage(mailbox, msg, forwardTo);
                counts[outcome]++;
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
    log.info("tidy_mailboxes.done", { mailboxes, ...counts });
}
