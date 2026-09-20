/**
 * Builds and sends the end-of-week balance message (group post) right
 * now. Used to be a fixed Friday-17:00 cron; as of 2026-09 the *decision*
 * of when to call this lives in `founder-meeting-balance-check.ts`
 * instead, which fires this the morning OF the "Founders Meeting"
 * calendar event — a recap of the closing week right before priorities
 * get reset in that meeting — falling back to Monday only if no such
 * meeting is scheduled that week. This file only knows how to send the
 * message, not when. Renamed from `friday-balance.ts`.
 *
 * `now` drives weekLabel/monday-of-week/week-of-year for every query —
 * on the real meeting-day path it's just "today", but the Monday fallback
 * passes a date inside the week that just ended, so this recaps that
 * concluded week instead of the brand-new one that started this morning.
 */
import { log } from "../lib/log.js";
import { sendGroupMessage } from "../lib/telegram.js";
import { currentWeekLabel, mondayOf } from "../lib/week.js";
import { formatFridayBalance } from "../messages/cycle.js";
import * as notion from "../notion.js";
const FOUNDERS = ["Madalena", "Mafalda", "Beatriz"];
export async function run(now = new Date()) {
    const weekLabel = currentWeekLabel(now);
    const mondayIso = mondayOf(now).toISOString();
    const [priorities, completed, overdue, focus] = await Promise.all([
        notion.getWeeklyPriorities(weekLabel),
        notion.getWeeklyCompletedSince(mondayIso),
        notion.getWeeklyOverdueTasks(),
        safeFounderFocus(),
    ]);
    const prioritiesByFounder = {
        Madalena: [],
        Mafalda: [],
        Beatriz: [],
    };
    for (const t of priorities) {
        if (t.owner === "Madalena" ||
            t.owner === "Mafalda" ||
            t.owner === "Beatriz") {
            prioritiesByFounder[t.owner].push(t);
        }
    }
    const text = formatFridayBalance({ weekLabel, prioritiesByFounder, completed, overdue, focus });
    const messageId = await sendGroupMessage(text, "MarkdownV2");
    log.info("cron.friday_balance.posted", {
        messageId,
        priorities: priorities.length,
        completed: completed.length,
        overdue: overdue.length,
        focusEntries: focus.length,
    });
}
// getActiveFounderFocuses (not getFounderFocusForWeek) on purpose — same
// fix as founder-focus-cycle.ts's runFocusCumpridoAsk: a founder's active
// row can carry a Semana number from whenever they actually set it, which
// won't always equal weekOfYear(now) once this trigger can fire on any
// weekday. Filtering by weekNumber silently dropped founders whose focus
// row hadn't been touched since a prior ISO week even though it was still
// their live, unanswered focus for right now — confirmed for real
// 2026-09-20 (balance showed only Madalena's focus, Mafalda's and
// Beatriz's were both written but tagged under a different Semana).
async function safeFounderFocus() {
    try {
        return await notion.getActiveFounderFocuses();
    }
    catch (err) {
        log.warn("cron.friday_balance.focus_unavailable", {
            err: err instanceof Error ? err.message : String(err),
        });
        return [];
    }
}
