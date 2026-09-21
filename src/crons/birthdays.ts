import { fetchUpcomingBirthdays } from "../lib/birthdays.js";
import { log } from "../lib/log.js";
import { sendGroupMessageWithSource } from "../lib/pulse-source.js";
import { PULSE_VIEW } from "../lib/pulse-views.js";
import { formatBirthdayDigest } from "../messages/birthdays.js";

/**
 * Daily birthday digest. Looks up kenko_customers in Studio Supabase for
 * birthdays TODAY only (no upcoming-week preview — dropped 2026-09-15,
 * founder's call), sends one formatted message to the founders' group.
 * Silent (no message sent) when nobody has a birthday today.
 *
 * Schedule: 08:00 Europe/Lisbon every day. Registered in src/server.ts.
 */
export async function run(): Promise<void> {
  let birthdays: Awaited<ReturnType<typeof fetchUpcomingBirthdays>>;
  try {
    birthdays = await fetchUpcomingBirthdays(new Date(), 0);
  } catch (err) {
    log.error("cron.birthdays.fetch_failed", {
      message: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  const message = formatBirthdayDigest(birthdays);
  if (!message) {
    log.info("cron.birthdays.no_matches", { total_birthdays_today: birthdays.length });
    return;
  }

  try {
    const messageId = await sendGroupMessageWithSource(message, [
      PULSE_VIEW.membershipState,
      PULSE_VIEW.classpackState,
      PULSE_VIEW.introHolderState,
    ]);
    log.info("cron.birthdays.posted", { messageId, today: birthdays.length });
  } catch (err) {
    log.error("cron.birthdays.send_failed", {
      message: err instanceof Error ? err.message : String(err),
    });
  }
}
