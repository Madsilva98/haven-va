/**
 * Monthly nudge to review docs/knowledge-base/tidy-mailboxes-feedback-log.md
 * — the doc where founder-flagged "TidyBot: devia ter arquivado" examples
 * get analyzed before any classifier/prompt change is made from them (see
 * that file's header). Counts entries still marked `pending review` and
 * only sends when there's at least one — no point nudging about an empty
 * queue.
 */
import { readFileSync } from "node:fs";
import { getTelegramId } from "../lib/founders.js";
import { log } from "../lib/log.js";
import { sendDM } from "../lib/telegram.js";
const PENDING_STATUS_RE = /Status:\s*\*\*pending review\*\*/g;
function countPendingEntries() {
    const text = readFileSync(new URL("../knowledge-base/tidy-mailboxes-feedback-log.md", import.meta.url), "utf8");
    return text.match(PENDING_STATUS_RE)?.length ?? 0;
}
function buildMessage(count) {
    const noun = count === 1 ? "apontamento" : "apontamentos";
    return (`📋 Lembrete mensal: há ${count} ${noun} pending review em ` +
        "tidy-mailboxes-feedback-log.md — vale a pena dar uma vista de olhos.");
}
export async function run() {
    let pendingCount;
    try {
        pendingCount = countPendingEntries();
    }
    catch (err) {
        log.warn("cron.tidy_mailboxes_feedback_reminder.log_read_failed", {
            err: err instanceof Error ? err.message : String(err),
        });
        return;
    }
    if (pendingCount === 0) {
        log.info("cron.tidy_mailboxes_feedback_reminder.skipped_no_pending");
        return;
    }
    const telegramId = getTelegramId("Madalena");
    if (telegramId === null) {
        log.warn("cron.tidy_mailboxes_feedback_reminder.no_telegram_id");
        return;
    }
    await sendDM(telegramId, buildMessage(pendingCount));
    log.info("cron.tidy_mailboxes_feedback_reminder.sent", { pendingCount });
}
