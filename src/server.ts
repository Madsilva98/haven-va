import cron from "node-cron";
import { buildBot } from "./bot/index.js";
import { run as runBirthdays } from "./crons/birthdays.js";
import { run as runChurnRisk } from "./crons/churn-risk.js";
import { run as runFounderMeetingBalanceCheck } from "./crons/founder-meeting-balance-check.js";
import { run as runFounderMeetingCheck } from "./crons/founder-meeting-check.js";
import { run as runLeadsEmailScan } from "./crons/leads-email-scan.js";
import { run as runLeadsIntroPack } from "./crons/leads-intro-pack.js";
import { run as runPipelineAlerts } from "./crons/pipeline-alerts.js";
import { run as runReminders } from "./crons/reminders.js";
import { run as runTidyMailboxes } from "./crons/tidy-mailboxes.js";
import { run as runTidyMailboxesFeedbackReminder } from "./crons/tidy-mailboxes-feedback-reminder.js";
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
      runFounderMeetingCheck().catch((e) =>
        log.error("cron.founder_meeting_check", { e: String(e) }),
      ),
    { timezone: TZ },
  ),
  cron.schedule(
    "0 8 * * *",
    () =>
      runFounderMeetingBalanceCheck().catch((e) =>
        log.error("cron.founder_meeting_balance_check", { e: String(e) }),
      ),
    { timezone: TZ },
  ),
  cron.schedule(
    "0 8 * * 1-5",
    () =>
      runPipelineAlerts().catch((e) =>
        log.error("cron.pipeline", { e: String(e) }),
      ),
    { timezone: TZ },
  ),
  cron.schedule(
    "0 7 * * *",
    () =>
      runTidyMailboxes().catch((e) =>
        log.error("cron.tidy_mailboxes", { e: String(e) }),
      ),
    { timezone: TZ },
  ),
  cron.schedule(
    "0 8 * * *",
    () =>
      runBirthdays().catch((e) =>
        log.error("cron.birthdays", { e: String(e) }),
      ),
    { timezone: TZ },
  ),
  cron.schedule(
    "0 9 1 * *",
    () =>
      runTidyMailboxesFeedbackReminder().catch((e) =>
        log.error("cron.tidy_mailboxes_feedback_reminder", { e: String(e) }),
      ),
    { timezone: TZ },
  ),
  cron.schedule(
    "15 8 * * 1",
    () =>
      runLeadsEmailScan().catch((e) =>
        log.error("cron.leads_email_scan", { e: String(e) }),
      ),
    { timezone: TZ },
  ),
  cron.schedule(
    "20 8 * * 1",
    () =>
      runLeadsIntroPack().catch((e) =>
        log.error("cron.leads_intro_pack", { e: String(e) }),
      ),
    { timezone: TZ },
  ),
  cron.schedule(
    "45 8 * * 1",
    () =>
      runChurnRisk().catch((e) =>
        log.error("cron.churn_risk", { e: String(e) }),
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
