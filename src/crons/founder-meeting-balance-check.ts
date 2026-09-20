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
 * 2. Otherwise, if today is Monday and no such meeting was scheduled at
 *    any point during the week that just ended, send the balance now as
 *    a fallback — recapping THAT concluded week (not the new one that
 *    started this morning) — so a week never goes without a balance.
 *    Changed from a Sunday fallback to Monday 2026-09-20, founder's
 *    call, so every message tied to the Founders Meeting shares one
 *    fallback day with founder-meeting-check.ts.
 * 3. Otherwise, do nothing today.
 *
 * Whenever week-balance actually sends (either branch above), the
 * personal Founder Focus "cumpriste?" check-in (`founder-focus-cycle.ts`)
 * fires right after, same `now` — that used to be its own fixed Sunday
 * 18:00 cron; merged here so both the team recap and the personal
 * check-in land on the same day, whichever day the meeting actually is.
 */
import { listEventsInRange } from "../lib/calendar.js";
import { runFocusCumpridoAsk } from "./founder-focus-cycle.js";
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

/** Was the meeting scheduled anywhere in the Mon–Sun week containing `reference`. */
async function meetingScheduledInWeekOf(reference: Date): Promise<boolean> {
  const events = await listEventsInRange(mondayOf(reference), sundayOf(reference));
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
    await sendWeekBalance(now);
    await runFocusCumpridoAsk(now);
    return;
  }

  if (now.getDay() !== 1) {
    log.debug("founder_meeting_balance_check.no_action");
    return;
  }

  // Today is Monday: the week to recap is the one that just ended
  // (yesterday, Sunday, was its last day) — not the new week starting
  // today, which would have no priorities/completions yet.
  const lastWeekReference = new Date(now);
  lastWeekReference.setDate(lastWeekReference.getDate() - 1);

  let scheduledLastWeek = false;
  try {
    scheduledLastWeek = await meetingScheduledInWeekOf(lastWeekReference);
  } catch (err) {
    log.error("founder_meeting_balance_check.week_lookup_failed", {
      message: err instanceof Error ? err.message : String(err),
    });
    // Fail safe: treat lookup failure as "not found" and send anyway —
    // same reasoning as founder-meeting-check.ts's Monday fallback.
  }

  if (scheduledLastWeek) {
    log.info("founder_meeting_balance_check.monday_skipped_meeting_scheduled");
    return;
  }

  log.info("founder_meeting_balance_check.monday_fallback_sent");
  await sendWeekBalance(lastWeekReference);
  await runFocusCumpridoAsk(now);
}
