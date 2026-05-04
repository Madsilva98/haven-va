import { log } from "../lib/log.js";
import { sendGroupMessage } from "../lib/telegram.js";
import { currentWeekLabel, mondayOf } from "../lib/week.js";
import { formatFridayBalance } from "../messages/cycle.js";
import * as notion from "../notion.js";
export async function run() {
    const weekLabel = currentWeekLabel();
    const mondayIso = mondayOf().toISOString();
    const [priorities, completed, overdue, focus] = await Promise.all([
        notion.getWeeklyPriorities(weekLabel),
        notion.getCompletedSince(mondayIso),
        notion.getOverdueTasks(),
        safeFounderFocus(weekLabel),
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
async function safeFounderFocus(weekLabel) {
    try {
        return await notion.getFounderFocusForWeek(weekLabel);
    }
    catch (err) {
        log.warn("cron.friday_balance.focus_unavailable", {
            err: err instanceof Error ? err.message : String(err),
        });
        return [];
    }
}
