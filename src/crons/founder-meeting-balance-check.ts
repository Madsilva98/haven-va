/**
 * Runs every morning (Monday–Sunday, see src/server.ts) and decides
 * whether to send the week-balance message (src/crons/week-balance.ts)
 * — replacing the old fixed Friday-17:00 schedule.
 *
 * The balance is meant to land the morning OF the "Founders Meeting" /
 * "Recurring Founders Meeting" — a recap of the week that's about to
 * close, right before the meeting where the next cycle's priorities get
 * set (see founder-meeting-check.ts for the other half of the cycle,
 * which fires the *morning after* that same meeting). Rule, in order:
 *
 * 1. If that meeting is scheduled for TODAY, send the balance now.
 * 2. Otherwise, if today is Sunday and no such meeting was scheduled at
 *    any point this week, send it now as a fallback so the week never
 *    goes without a balance. (This pairs naturally with
 *    founder-meeting-check.ts's own Monday fallback the next morning —
 *    Sunday recap, Monday reset.)
 * 3. Otherwise, do nothing today.
 */
import { listEventsInRange } from "../lib/calendar.js";
import { log } from "../lib/log.js";
import { mondayOf, sundayOf } from "../lib/week.js";
import { run as sendWeekBalance } from "./week-balance.js";

const MEETING_KEYWORD = "founders meeting"; // matches both "Founders Meeting" and "Recurring Founders Meeting"

function matchesFounderMeeting(title: string): boolean {
  return title.toLowerCase().includes(MEETING_KEYWORD);
}

function startOfDay(date: Date): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

function endOfDay(date: Date): Date {
  const d = new Date(date);
  d.setHours(23, 59, 59, 999);
  return d;
}

async function meetingScheduledToday(now: Date): Promise<boolean> {
  const events = await listEventsInRange(startOfDay(now), endOfDay(now));
  return events.some((e) => matchesFounderMeeting(e.title));
}

async function meetingScheduledThisWeek(now: Date): Promise<boolean> {
  const events = await listEventsInRange(mondayOf(now), sundayOf(now));
  return events.some((e) => matchesFounderMeeting(e.title));
}

export async function run(now: Date = new Date()): Promise<void> {
  let today = false;
  try {
    today = await meetingScheduledToday(now);
  } catch (err) {
    log.error("founder_meeting_balance_check.today_lookup_failed", {
      message: err instanceof Error ? err.message : String(err),
    });
  }

  if (today) {
    log.info("founder_meeting_balance_check.meeting_today");
    await sendWeekBalance();
    return;
  }

  if (now.getDay() !== 0) {
    log.debug("founder_meeting_balance_check.no_action");
    return;
  }

  let scheduledThisWeek = false;
  try {
    scheduledThisWeek = await meetingScheduledThisWeek(now);
  } catch (err) {
    log.error("founder_meeting_balance_check.week_lookup_failed", {
      message: err instanceof Error ? err.message : String(err),
    });
    // Fail safe: treat lookup failure as "not found" and send anyway —
    // same reasoning as founder-meeting-check.ts's Monday fallback.
  }

  if (scheduledThisWeek) {
    log.info("founder_meeting_balance_check.sunday_skipped_meeting_scheduled");
    return;
  }

  log.info("founder_meeting_balance_check.sunday_fallback_sent");
  await sendWeekBalance();
}
