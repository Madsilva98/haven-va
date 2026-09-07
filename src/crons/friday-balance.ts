import { log } from "../lib/log.js";
import { sendGroupMessage } from "../lib/telegram.js";
import { currentWeekLabel, mondayOf, weekOfYear } from "../lib/week.js";
import { formatFridayBalance } from "../messages/cycle.js";
import * as notion from "../notion.js";
import type { FounderFocusEntry } from "../types.js";

export async function run(): Promise<void> {
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

async function safeFounderFocus(weekNumber: number): Promise<FounderFocusEntry[]> {
  try {
    return await notion.getFounderFocusForWeek(weekNumber);
  } catch (err) {
    log.warn("cron.friday_balance.focus_unavailable", {
      err: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}
