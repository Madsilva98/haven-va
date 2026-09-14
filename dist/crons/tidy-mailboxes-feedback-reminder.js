/**
 * Monthly nudge to review docs/knowledge-base/tidy-mailboxes-feedback-log.md
 * — the doc where founder-flagged "TidyBot: devia ter arquivado" examples
 * get analyzed before any classifier/prompt change is made from them (see
 * that file's header). This cron doesn't read or summarize the log itself,
 * just reminds a founder it exists and is worth a look.
 */
import { getTelegramId } from "../lib/founders.js";
import { log } from "../lib/log.js";
import { sendDM } from "../lib/telegram.js";
const MESSAGE = "📋 Lembrete mensal: vale a pena dar uma vista de olhos ao " +
    "tidy-mailboxes-feedback-log.md para ver se há apontamentos novos para " +
    "aprovar (ou rejeitar).";
export async function run() {
    const telegramId = getTelegramId("Madalena");
    if (telegramId === null) {
        log.warn("cron.tidy_mailboxes_feedback_reminder.no_telegram_id");
        return;
    }
    await sendDM(telegramId, MESSAGE);
    log.info("cron.tidy_mailboxes_feedback_reminder.sent");
}
