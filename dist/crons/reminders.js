import { getTelegramId } from "../lib/founders.js";
import { log } from "../lib/log.js";
import { nextOccurrence } from "../lib/recurrence.js";
import { sendDM } from "../lib/telegram.js";
import { formatReminderMessage } from "../messages/pipeline.js";
import * as notion from "../notion.js";
// Guards against two ticks of this every-5-minutes cron overlapping: if a
// run is ever slow enough (Notion latency, a big backlog of due reminders)
// to still be mid-loop when the next tick fires, without this a reminder
// could be fetched by both ticks before either marks it sent, and go out
// twice. Single Node process, so a module-level flag is enough — no need
// for a Notion-side or distributed lock.
let running = false;
export async function run() {
    if (running) {
        log.warn("reminders.overlap_skipped");
        return;
    }
    running = true;
    try {
        await runOnce();
    }
    finally {
        running = false;
    }
}
async function runOnce() {
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
        const recipients = r.paraQuem.map((name) => ({ name, tgId: getTelegramId(name) }));
        for (const rec of recipients) {
            if (rec.tgId === null) {
                log.warn("reminders.no_telegram_id", { id: r.id, paraQuem: rec.name });
            }
        }
        const valid = recipients.filter((rec) => rec.tgId !== null);
        if (valid.length === 0) {
            skipped++;
            continue;
        }
        // Mark sent BEFORE sending the DM(s): if this write fails, we skip
        // sending entirely and retry the whole reminder next tick — no
        // duplicate DM. The trade-off is the opposite failure mode (a DM send
        // failing after this succeeds means that reminder won't be retried),
        // which is the rarer and less annoying of the two to a founder.
        try {
            await notion.markReminderSent(r.id);
        }
        catch (err) {
            log.error("reminders.mark_sent_failed", {
                id: r.id,
                message: err instanceof Error ? err.message : String(err),
            });
            failed++;
            continue;
        }
        let anySent = false;
        for (const rec of valid) {
            try {
                await sendDM(rec.tgId, formatReminderMessage(r));
                anySent = true;
            }
            catch (err) {
                log.error("reminders.dm_failed", {
                    id: r.id,
                    paraQuem: rec.name,
                    message: err instanceof Error ? err.message : String(err),
                });
                failed++;
            }
        }
        if (!anySent)
            continue; // already marked sent; won't be retried — logged above for follow-up
        if (r.recurrence && !r.feito) {
            try {
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
            catch (err) {
                log.error("reminders.recurrence_reschedule_failed", {
                    id: r.id,
                    message: err instanceof Error ? err.message : String(err),
                });
                failed++;
                continue;
            }
        }
        sent++;
    }
    log.info("reminders.done", { total: due.length, sent, skipped, failed });
}
