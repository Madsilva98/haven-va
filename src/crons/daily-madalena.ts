import { foundersOnCadence } from "../lib/cadence.js";
import { getTelegramId } from "../lib/founders.js";
import { log } from "../lib/log.js";
import { sendDM } from "../lib/telegram.js";
import { currentWeekLabel } from "../lib/week.js";
import { formatDailyDM, rankTasks } from "../messages/cycle.js";
import * as notion from "../notion.js";

export async function run(): Promise<void> {
  const dailyFounders = foundersOnCadence("daily");
  if (dailyFounders.length === 0) {
    log.info("cron.daily_madalena.no_daily_founders");
    return;
  }

  const priorities = await notion.getWeeklyPriorities(currentWeekLabel());

  let sent = 0;
  for (const founder of dailyFounders) {
    const tgId = getTelegramId(founder);
    if (tgId === null) {
      log.warn("cron.daily_madalena.no_telegram_id", { founder });
      continue;
    }

    try {
      const tasks = priorities.filter((t) => t.owner === founder);
      const ranked = rankTasks(tasks);

      const text = formatDailyDM({ founder, tasks: ranked });
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
