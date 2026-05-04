import { foundersOnCadence } from "../lib/cadence.js";
import * as calendar from "../lib/calendar.js";
import { getTelegramId } from "../lib/founders.js";
import { log } from "../lib/log.js";
import { sendDM } from "../lib/telegram.js";
import { formatDailyDM, rankTasks } from "../messages/cycle.js";
import * as notion from "../notion.js";
import type { CalendarEvent } from "../lib/calendar.js";

const WORK_START = parseInt(process.env.WORK_START_HOUR ?? "9", 10);
const WORK_END = parseInt(process.env.WORK_END_HOUR ?? "19", 10);

export function buildFreeTimeDesc(events: CalendarEvent[]): string {
  const timed = events.filter((e) => !e.allDay);
  const workStart = new Date();
  workStart.setHours(WORK_START, 0, 0, 0);
  const workEnd = new Date();
  workEnd.setHours(WORK_END, 0, 0, 0);

  const upcoming = timed
    .filter((e) => e.start >= workStart && e.start < workEnd)
    .sort((a, b) => a.start.getTime() - b.start.getTime());

  if (upcoming.length === 0) {
    const allDay = events.filter((e) => e.allDay);
    if (allDay.length > 0) {
      return `dia livre (${allDay.map((e) => e.title).join(", ")})`;
    }
    return "dia livre";
  }

  const first = upcoming[0]!;
  const hour = first.start.getHours();
  const min = first.start.getMinutes();
  const timeStr =
    min === 0 ? `${hour}h` : `${hour}h${String(min).padStart(2, "0")}`;
  return `manhã livre até às ${timeStr} (${first.title})`;
}

export async function run(): Promise<void> {
  const dailyFounders = foundersOnCadence("daily");
  if (dailyFounders.length === 0) {
    log.info("cron.daily_madalena.no_daily_founders");
    return;
  }

  let sent = 0;
  for (const founder of dailyFounders) {
    const tgId = getTelegramId(founder);
    if (tgId === null) {
      log.warn("cron.daily_madalena.no_telegram_id", { founder });
      continue;
    }

    try {
      const tasks = await notion.getOpenTasksFor(founder);
      const ranked = rankTasks(tasks);

      let calDesc = "";
      if (founder === "Madalena" && calendar.isAuthenticated()) {
        const events = await calendar.listEventsToday();
        calDesc = buildFreeTimeDesc(events);
      }

      const text = formatDailyDM({ founder, tasks: ranked, calDesc });
      await sendDM(tgId, text, "MarkdownV2");
      sent++;
      log.info("cron.daily_madalena.dm_sent", { founder, tasks: ranked.length });
    } catch (err) {
      log.warn("cron.daily_madalena.dm_failed", {
        founder,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  log.info("cron.daily_madalena.done", { sent });
}
