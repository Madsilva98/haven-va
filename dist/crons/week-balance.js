/**
 * Builds and sends the end-of-week balance message (group post) right
 * now. Used to be a fixed Friday-17:00 cron; as of 2026-09 the *decision*
 * of when to call this lives in `founder-meeting-balance-check.ts`
 * instead, which fires this the morning OF the "Founders Meeting"
 * calendar event — a recap of the closing week right before priorities
 * get reset in that meeting — falling back to Sunday only if no such
 * meeting is scheduled that week. This file only knows how to send the
 * message, not when. Renamed from `friday-balance.ts`.
 */
import { log } from "../lib/log.js";
import { sendGroupMessage } from "../lib/telegram.js";
import { currentWeekLabel, mondayOf, weekOfYear } from "../lib/week.js";
import { formatFridayBalance } from "../messages/cycle.js";
import * as notion from "../notion.js";
export async function run() {
    const weekLabel = currentWeekLabel();
    const mondayIso = mondayOf().toISOString();
    const [priorities, completed, overdue, focus] = await Promise.all([
        notion.getWeeklyPriorities(weekLabel),
        notion.getWeeklyCompletedSince(mondayIso),
        notion.getWeeklyOverdueTasks(),
        safeFounderFocus(weekOfYear()),
    ]);
    const text = formatFridayBalance({ weekLabel, priorities, completed, overdue, focus });
    const messageId = await sendGroupMessage(text, "MarkdownV2");
    log.info("cron.friday_balance.posted", {
        messageId,
        priorities: priorities.length,
        completed: completed.length,
        overdue: overdue.length,
        focusEntries: focus.length,
    });
}
async function safeFounderFocus(weekNumber) {
    try {
        return await notion.getFounderFocusForWeek(weekNumber);
    }
    catch (err) {
        log.warn("cron.friday_balance.focus_unavailable", {
            err: err instanceof Error ? err.message : String(err),
        });
        return [];
    }
}
