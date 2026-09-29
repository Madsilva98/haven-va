/**
 * Runs every morning (Monday–Sunday, see src/server.ts) and decides
 * whether to send the week-balance message (src/crons/week-balance.ts)
 * — replacing the old fixed Friday-17:00 schedule.
 *
 * **Week-balance disabled, 2026-09-29 (founder's call) — WEEK_BALANCE_ENABLED
 * below.** Left in code deliberately (not deleted, not unregistered from
 * server.ts) since this cron still does real work besides that message: the
 * personal Founder Focus "cumpriste?" check-in (below) still needs the same
 * meeting-detection logic to know when to fire. Flip the flag to re-enable
 * week-balance without touching anything else.
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
 * Whenever the meeting-detection above fires (either branch), the personal
 * Founder Focus "cumpriste?" check-in (`founder-focus-cycle.ts`) still runs
 * right after, same `now`, REGARDLESS of WEEK_BALANCE_ENABLED — that used to
 * be its own fixed Sunday 18:00 cron; merged here so both the team recap and
 * the personal check-in land on the same day, whichever day the meeting
 * actually is. Disabling week-balance must not silently disable this too.
 */
import { listEventsInRange } from "../lib/calendar.js";
import { runFocusCumpridoAsk } from "./founder-focus-cycle.js";
import { log } from "../lib/log.js";

const WEEK_BALANCE_ENABLED = false;
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
    if (WEEK_BALANCE_ENABLED) {
      await sendWeekBalance(now);
    } else {
      log.debug("founder_meeting_balance_check.week_balance_disabled");
    }
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

  if (WEEK_BALANCE_ENABLED) {
    log.info("founder_meeting_balance_check.monday_fallback_sent");
    await sendWeekBalance(lastWeekReference);
  } else {
    log.debug("founder_meeting_balance_check.week_balance_disabled");
  }
  await runFocusCumpridoAsk(now);
}
