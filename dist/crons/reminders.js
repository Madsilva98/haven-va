import { getTelegramId } from "../lib/founders.js";
import { log } from "../lib/log.js";
import { sendDM } from "../lib/telegram.js";
import { formatReminderMessage } from "../messages/pipeline.js";
import * as notion from "../notion.js";
export async function run() {
    let due = [];
    try {
        due = await notion.getDueReminders();
    }
    catch (err) {
        log.error("reminders.fetch_failed", {
            message: err instanceof Error ? err.message : String(err),
        });
        return;
    }
    let sent = 0;
    let skipped = 0;
    let failed = 0;
    for (const r of due) {
        const tgId = getTelegramId(r.paraQuem);
        if (tgId === null) {
            log.warn("reminders.no_telegram_id", { id: r.id, paraQuem: r.paraQuem });
            skipped++;
            continue;
        }
        try {
            await sendDM(tgId, formatReminderMessage(r));
        }
        catch (err) {
            log.error("reminders.dm_failed", {
                id: r.id,
                message: err instanceof Error ? err.message : String(err),
            });
            failed++;
            continue;
        }
        try {
            await notion.markReminderSent(r.id);
            sent++;
        }
        catch (err) {
            log.error("reminders.mark_sent_failed", {
                id: r.id,
                message: err instanceof Error ? err.message : String(err),
            });
            failed++;
        }
    }
    log.info("reminders.done", { total: due.length, sent, skipped, failed });
}
