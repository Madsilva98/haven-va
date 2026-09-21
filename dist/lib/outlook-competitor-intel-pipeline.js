/**
 * Live competitor-intel pipeline — reads a dedicated Outlook shared mailbox
 * (OUTLOOK_COMPETITOR_INTEL_MAILBOX) that a founder manually resubscribes
 * competitor/inspiration newsletters under, extracts findings with Claude
 * Haiku, and writes them to the Competitor Intel Notion DB. See
 * docs/knowledge-base/competitor-intel.md.
 *
 * Single phase — no sender-matching "tidy" step, because the mailbox itself
 * IS the curated intake (nothing lands in it that isn't a deliberately
 * resubscribed source). The Fontes DB (getActiveCompetitorSources) is not
 * consulted by this pipeline; it's the founder's own reference list of what
 * she's subscribed and how she's classified each one, not a filter the code
 * reads.
 *
 * State: unread = not yet processed, plain and simple. No category tag, no
 * archiving — a dedicated mailbox nothing else touches doesn't need
 * tidying, so this pipeline only ever changes one thing per message
 * (isRead), and only after a full success. A message that errors during
 * extraction or the Notion write stays unread and is retried next run.
 */
import * as outlook from "./outlook.js";
import { extractCompetitorIntel } from "./extract-competitor-intel.js";
import * as notion from "../notion.js";
import { log } from "./log.js";
export function competitorIntelMailbox() {
    return process.env.OUTLOOK_COMPETITOR_INTEL_MAILBOX || null;
}
export function isDryRun() {
    return process.env.COMPETITOR_INTEL_DRY_RUN === "true";
}
function truncate(text, max) {
    const trimmed = text.trim();
    return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}
export async function processOutlookCompetitorIntel() {
    const dryRun = isDryRun();
    const summary = {
        messagesSeen: 0,
        messagesProcessed: 0,
        findingsWritten: 0,
        errors: 0,
        byMessage: [],
    };
    const mailbox = competitorIntelMailbox();
    if (!mailbox) {
        log.debug("competitor_intel_outlook.disabled", { reason: "OUTLOOK_COMPETITOR_INTEL_MAILBOX not set" });
        return summary;
    }
    if (!outlook.isAuthenticated()) {
        log.debug("competitor_intel_outlook.disabled", { reason: "outlook not authenticated — run scripts/outlook-auth.mjs" });
        return summary;
    }
    const allMessages = await outlook.listInboxMessages(mailbox);
    const messages = allMessages.filter((m) => !m.isRead);
    summary.messagesSeen = messages.length;
    for (const msg of messages) {
        let findings;
        try {
            findings = await extractCompetitorIntel({
                fromName: msg.from.name,
                fromEmail: msg.from.email,
                subject: msg.subject,
                body: msg.body,
            });
        }
        catch (err) {
            log.error("competitor_intel_outlook.extraction_failed", {
                messageId: msg.id,
                subject: msg.subject,
                message: err instanceof Error ? err.message : String(err),
            });
            summary.errors++;
            continue; // stays unread — retried next run
        }
        try {
            for (const finding of findings) {
                if (dryRun) {
                    log.info("competitor_intel_outlook.would_write", {
                        fonte: msg.from.name,
                        tipo: finding.tipo,
                        resumo: finding.resumo,
                    });
                    continue;
                }
                await notion.createCompetitorIntelFinding({
                    nome: truncate(finding.resumo, 70),
                    fonte: msg.from.name,
                    tipos: [finding.tipo],
                    resumo: finding.resumo,
                    dataEmail: msg.receivedDateTime.slice(0, 10),
                    assuntoEmail: msg.subject,
                    link: msg.webLink,
                });
                summary.findingsWritten++;
            }
        }
        catch (err) {
            log.error("competitor_intel_outlook.notion_write_failed", {
                messageId: msg.id,
                subject: msg.subject,
                message: err instanceof Error ? err.message : String(err),
            });
            summary.errors++;
            continue; // partial write — stays unread, retried next run (may duplicate some findings)
        }
        summary.byMessage.push({
            fromName: msg.from.name,
            fromEmail: msg.from.email,
            subject: msg.subject,
            findings,
        });
        summary.messagesProcessed++;
        if (dryRun) {
            log.info("competitor_intel_outlook.would_mark_read", { messageId: msg.id, subject: msg.subject });
        }
        else {
            await outlook.markMessageRead(mailbox, msg.id);
        }
    }
    log.info("competitor_intel_outlook.process_done", {
        dryRun,
        messagesSeen: summary.messagesSeen,
        messagesProcessed: summary.messagesProcessed,
        findingsWritten: summary.findingsWritten,
        errors: summary.errors,
    });
    return summary;
}
