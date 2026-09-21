/**
 * Weekly competitor-intel cron — reads the dedicated Outlook shared mailbox
 * (OUTLOOK_COMPETITOR_INTEL_MAILBOX) a founder resubscribes competitor and
 * "inspiration" business newsletters under, extracts findings with Claude
 * Haiku, and writes them to the Competitor Intel Notion DB.
 *
 * Fully autonomous — no review gate before writing to Notion. Sends one
 * Telegram digest at the end either way, so founders know it ran even on a
 * quiet week. Gracefully no-ops if Outlook isn't authenticated, the mailbox
 * env var is unset, or either Notion DB id is unset, same as every other
 * optional feature here.
 *
 * See docs/knowledge-base/competitor-intel.md — including why this replaced
 * the original Gmail-based design (Google's `gmail.modify` restricted-scope
 * problem) and why the pre-migration Gmail backlog was processed by hand
 * rather than with code.
 */
import { processOutlookCompetitorIntel } from "../lib/outlook-competitor-intel-pipeline.js";
import { formatCompetitorIntelDigest } from "../messages/competitor-intel.js";
import { sendGroupMessage } from "../lib/telegram.js";
import { log } from "../lib/log.js";
import * as outlook from "../lib/outlook.js";
export async function run() {
    if (!process.env.NOTION_COMPETITOR_INTEL_DB_ID || !process.env.OUTLOOK_COMPETITOR_INTEL_MAILBOX) {
        log.debug("competitor_intel.disabled", {
            reason: "NOTION_COMPETITOR_INTEL_DB_ID or OUTLOOK_COMPETITOR_INTEL_MAILBOX not set",
        });
        return;
    }
    if (!outlook.isAuthenticated()) {
        log.debug("competitor_intel.disabled", { reason: "outlook not authenticated — run scripts/outlook-auth.mjs" });
        return;
    }
    const summary = await processOutlookCompetitorIntel();
    const text = formatCompetitorIntelDigest({ summary });
    const messageId = await sendGroupMessage(text, "MarkdownV2");
    log.info("cron.competitor_intel.posted", {
        messageId,
        messagesProcessed: summary.messagesProcessed,
        findingsWritten: summary.findingsWritten,
        errors: summary.errors,
    });
}
