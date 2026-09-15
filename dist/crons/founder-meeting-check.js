/**
 * Runs every morning (Monday–Sunday, see src/server.ts) and decides
 * whether to send the weekly priorities message (src/crons/weekly-
 * priorities.ts) — replacing the old fixed Monday-08:00 schedule.
 *
 * The founders set their weekly priorities/foco live during their
 * "Founders Meeting" / "Recurring Founders Meeting" calendar event, which
 * is usually Tuesday lunch but can move. Rule, in order:
 *
 * 1. If that meeting ended sometime since yesterday, send the weekly
 *    message now — the morning right after the meeting.
 * 2. Otherwise, if today is Monday and no such meeting is scheduled
 *    anywhere later this week, send it now as a fallback so the week
 *    never goes without one.
 * 3. Otherwise, do nothing today.
 *
 * By design, rule 1 can fire again later in the same week even after
 * rule 2 already sent a Monday fallback — if the meeting gets scheduled
 * or rescheduled after Monday and actually happens, the founders get the
 * fresh version too.
 */
import { listEventsInRange } from "../lib/calendar.js";
import { log } from "../lib/log.js";
import { sundayOf } from "../lib/week.js";
import { run as sendWeeklyPriorities } from "./weekly-priorities.js";
const MEETING_KEYWORD = "founders meeting"; // matches both "Founders Meeting" and "Recurring Founders Meeting"
function matchesFounderMeeting(title) {
    return title.toLowerCase().includes(MEETING_KEYWORD);
}
async function meetingHappenedSinceYesterday(now) {
    const from = new Date(now);
    from.setDate(from.getDate() - 1);
    from.setHours(0, 0, 0, 0);
    const events = await listEventsInRange(from, now);
    return events.some((e) => matchesFounderMeeting(e.title) && e.end.getTime() <= now.getTime());
}
async function meetingScheduledThisWeek(now) {
    const events = await listEventsInRange(now, sundayOf(now));
    return events.some((e) => matchesFounderMeeting(e.title));
}
export async function run(now = new Date()) {
    let happened = false;
    try {
        happened = await meetingHappenedSinceYesterday(now);
    }
    catch (err) {
        log.error("founder_meeting_check.happened_lookup_failed", {
            message: err instanceof Error ? err.message : String(err),
        });
    }
    if (happened) {
        log.info("founder_meeting_check.meeting_detected");
        await sendWeeklyPriorities();
        return;
    }
    if (now.getDay() !== 1) {
        log.debug("founder_meeting_check.no_action");
        return;
    }
    let scheduledThisWeek = false;
    try {
        scheduledThisWeek = await meetingScheduledThisWeek(now);
    }
    catch (err) {
        log.error("founder_meeting_check.scheduled_lookup_failed", {
            message: err instanceof Error ? err.message : String(err),
        });
        // Fail safe by falling through to sending anyway: not knowing whether
        // a meeting is scheduled is treated the same as "none found" — missing
        // the week's message entirely because the calendar API hiccuped is
        // worse than an occasional extra send.
    }
    if (scheduledThisWeek) {
        log.info("founder_meeting_check.monday_skipped_meeting_scheduled");
        return;
    }
    log.info("founder_meeting_check.monday_fallback_sent");
    await sendWeeklyPriorities();
}
