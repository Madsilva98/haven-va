import { fetchUpcomingBirthdays } from "../lib/birthdays.js";
import { log } from "../lib/log.js";
import { sendGroupMessage } from "../lib/telegram.js";
import { formatBirthdayDigest } from "../messages/birthdays.js";

/**
 * Daily birthday digest. Looks up kenko_customers in Studio Supabase
 * for birthdays today + next 7 days, sends one formatted message to
 * the founders' group. Silent (no message sent) when there's nothing
 * to announce.
 *
 * Schedule: 08:00 Europe/Lisbon every day. Registered in src/server.ts.
 */
export async function run(): Promise<void> {
  let birthdays: Awaited<ReturnType<typeof fetchUpcomingBirthdays>>;
  try {
    birthdays = await fetchUpcomingBirthdays(new Date(), 7);
  } catch (err) {
    log.error("cron.birthdays.fetch_failed", {
      message: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  const message = formatBirthdayDigest(birthdays);
  if (!message) {
    log.info("cron.birthdays.no_matches", {
      window_days: 7,
      total_birthdays_with_dob: birthdays.length,
    });
    return;
  }

  try {
    const messageId = await sendGroupMessage(message);
    log.info("cron.birthdays.posted", {
      messageId,
      today: birthdays.filter((b) => b.daysUntil === 0).length,
      upcoming: birthdays.filter((b) => b.daysUntil >= 1 && b.daysUntil <= 7).length,
    });
  } catch (err) {
    log.error("cron.birthdays.send_failed", {
      message: err instanceof Error ? err.message : String(err),
    });
  }
}
