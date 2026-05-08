import { getTelegramId } from "../lib/founders.js";
import { log } from "../lib/log.js";
import { sendDM } from "../lib/telegram.js";
import { formatReminderMessage } from "../messages/pipeline.js";
import * as notion from "../notion.js";
function nextOccurrence(whenIso, recurrence) {
    const d = new Date(whenIso);
    if (recurrence === "diária")
        d.setDate(d.getDate() + 1);
    else if (recurrence === "semanal")
        d.setDate(d.getDate() + 7);
    else if (recurrence === "mensal")
        d.setMonth(d.getMonth() + 1);
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
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
            if (r.recurrence) {
                const nextWhen = nextOccurrence(r.quando, r.recurrence);
                await notion.createReminder({
                    texto: r.texto,
                    paraQuem: r.paraQuem,
                    quando: nextWhen,
                    origem: r.origem,
                    recurrence: r.recurrence,
                });
                log.info("reminders.next_scheduled", { id: r.id, recurrence: r.recurrence, nextWhen });
            }
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
