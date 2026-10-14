/**
 * Weekly competitor-intel cron — reads the dedicated Outlook shared mailbox
 * (OUTLOOK_COMPETITOR_INTEL_MAILBOX) a founder resubscribes competitor and
 * "inspiration" business newsletters under, extracts findings with Claude
 * Haiku, and writes them to the Competitor Intel Notion DB.
 *
 * Fully autonomous — no review gate before writing to Notion. Silent since
 * 2026-10-08: it runs Monday 02:30 Lisbon so haven-comms' weekly
 * competitor_movements.py (after the 04:00 scrape) can read the week's findings
 * from Notion and judge them with Instagram and the websites; the group hears
 * about the result from competitor-movements.ts at 08:30. This run's error count
 * is left in DATA_DIR/competitor-intel-last-run.json for that message.
 * Gracefully no-ops if Outlook isn't authenticated, the mailbox env var is
 * unset, or either Notion DB id is unset, same as every other optional feature.
 *
 * See docs/knowledge-base/competitor-intel.md — including why this replaced
 * the original Gmail-based design (Google's `gmail.modify` restricted-scope
 * problem) and why the pre-migration Gmail backlog was processed by hand
 * rather than with code.
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { processOutlookCompetitorIntel } from "../lib/outlook-competitor-intel-pipeline.js";
import { log } from "../lib/log.js";
import * as outlook from "../lib/outlook.js";
export const LAST_RUN_PATH = path.join(process.env.DATA_DIR ?? ".", "competitor-intel-last-run.json");
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
    try {
        writeFileSync(LAST_RUN_PATH, JSON.stringify({ at: new Date().toISOString(), errors: summary.errors }));
    }
    catch (e) {
        log.warn("cron.competitor_intel.last_run_write_failed", { e: String(e) });
    }
    log.info("cron.competitor_intel.done", {
        messagesProcessed: summary.messagesProcessed,
        findingsWritten: summary.findingsWritten,
        errors: summary.errors,
    });
}
