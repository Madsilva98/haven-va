import cron from "node-cron";
import { buildBot } from "./bot/index.js";
import { run as runDailyMadalena } from "./crons/daily-madalena.js";
import { run as runFridayBalance } from "./crons/friday-balance.js";
import { run as runMondayPriorities } from "./crons/monday-priorities.js";
import { run as runPipelineAlerts } from "./crons/pipeline-alerts.js";
import { run as runReminders } from "./crons/reminders.js";
import { run as runWeekendBrief } from "./crons/weekend-brief.js";
import { log } from "./lib/log.js";
import * as notion from "./notion.js";

const TZ = process.env.TZ ?? "Europe/Lisbon";

// Resolve data_source_id for every configured Notion DB before anything
// else can fire. Missing resolution = every cron + every assistant call
// throws at runtime. See docs/knowledge-base/notion-api-gotchas.md
// "multi-source breaking trap".
await notion.initialize();

const tasks = [
  cron.schedule(
    "*/5 * * * *",
    () => runReminders().catch((e) => log.error("cron.reminders", { e: String(e) })),
    { timezone: TZ },
  ),
  cron.schedule(
    "0 8 * * *",
    () =>
      runDailyMadalena().catch((e) =>
        log.error("cron.daily_madalena", { e: String(e) }),
      ),
    { timezone: TZ },
  ),
  cron.schedule(
    "0 8 * * 1",
    () =>
      runMondayPriorities().catch((e) =>
        log.error("cron.monday", { e: String(e) }),
      ),
    { timezone: TZ },
  ),
  cron.schedule(
    "0 17 * * 5",
    () =>
      runFridayBalance().catch((e) =>
        log.error("cron.friday", { e: String(e) }),
      ),
    { timezone: TZ },
  ),
  cron.schedule(
    "0 9 * * 6",
    () =>
      runWeekendBrief().catch((e) =>
        log.error("cron.weekend", { e: String(e) }),
      ),
    { timezone: TZ },
  ),
  cron.schedule(
    "0 */4 * * 1-5",
    () =>
      runPipelineAlerts().catch((e) =>
        log.error("cron.pipeline", { e: String(e) }),
      ),
    { timezone: TZ },
  ),
];

log.info("server.crons_registered", { count: tasks.length });

const bot = buildBot();

async function shutdown(): Promise<void> {
  log.info("server.shutdown");
  tasks.forEach((t) => t.stop());
  try {
    await bot.stop();
  } catch (err) {
    log.error("server.stop_failed", { err: String(err) });
  }
}

process.once("SIGINT", () => void shutdown().then(() => process.exit(0)));
process.once("SIGTERM", () => void shutdown().then(() => process.exit(0)));

bot.start({
  onStart: (info) => log.info("bot.started", { username: info.username }),
});
