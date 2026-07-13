import { getTelegramId } from "../lib/founders.js";
import { log } from "../lib/log.js";
import { sendDM } from "../lib/telegram.js";
import { formatReminderMessage } from "../messages/pipeline.js";
import * as notion from "../notion.js";
import type { ReminderRecurrence } from "../types.js";

function nextOccurrence(whenIso: string, recurrence: ReminderRecurrence): string {
  // UTC-only arithmetic + toISOString(): keeps the stored value an
  // unambiguous absolute UTC instant, matching every other writer of
  // Quando. Building this from local getters (getHours, no "Z") used to
  // relabel Lisbon wall-clock as UTC, delaying every 2nd+ recurring fire
  // by the DST offset.
  const d = new Date(whenIso);
  if (recurrence === "diária") d.setUTCDate(d.getUTCDate() + 1);
  else if (recurrence === "semanal") d.setUTCDate(d.getUTCDate() + 7);
  else if (recurrence === "mensal") d.setUTCMonth(d.getUTCMonth() + 1);
  return d.toISOString();
}

export async function run(): Promise<void> {
  let due: Awaited<ReturnType<typeof notion.getDueReminders>> = [];
  try {
    due = await notion.getDueReminders();
  } catch (err) {
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
    } catch (err) {
      log.error("reminders.dm_failed", {
        id: r.id,
        message: err instanceof Error ? err.message : String(err),
      });
      failed++;
      continue;
    }
    try {
      await notion.markReminderSent(r.id);
      if (r.recurrence && !r.feito) {
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
    } catch (err) {
      log.error("reminders.mark_sent_failed", {
        id: r.id,
        message: err instanceof Error ? err.message : String(err),
      });
      failed++;
    }
  }

  log.info("reminders.done", { total: due.length, sent, skipped, failed });
}
