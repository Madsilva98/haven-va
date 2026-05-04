import { log } from "../lib/log.js";
import { sendGroupMessage } from "../lib/telegram.js";
import { currentWeekLabel } from "../lib/week.js";
import { formatWeekendBrief } from "../messages/cycle.js";
import * as notion from "../notion.js";
import type { FounderFocusEntry, FounderName } from "../types.js";

export async function run(): Promise<void> {
  const weekLabel = currentWeekLabel();

  const [openTasks, focusByFounder, toDiscuss] = await Promise.all([
    notion.getOpenTasks(),
    safeFounderFocus(weekLabel),
    safeToDiscuss(),
  ]);

  const text = formatWeekendBrief({ weekLabel, openTasks, focusByFounder, toDiscuss });
  const messageId = await sendGroupMessage(text, "MarkdownV2");
  log.info("cron.weekend_brief.posted", {
    messageId,
    openTasks: openTasks.length,
    focusEntries: focusByFounder.length,
    toDiscuss: toDiscuss.length,
  });
}

async function safeFounderFocus(weekLabel: string): Promise<FounderFocusEntry[]> {
  try {
    return await notion.getFounderFocusForWeek(weekLabel);
  } catch (err) {
    log.warn("cron.weekend_brief.focus_unavailable", {
      err: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

async function safeToDiscuss(): Promise<{ tema: string; adicionadoPor: FounderName }[]> {
  try {
    const fn = (notion as { getToDiscussPending?: () => Promise<unknown> }).getToDiscussPending;
    if (typeof fn !== "function") return [];
    const rows = (await fn()) as Array<{ tema: string; adicionadoPor: FounderName }>;
    return rows.map((r) => ({ tema: r.tema, adicionadoPor: r.adicionadoPor }));
  } catch (err) {
    log.warn("cron.weekend_brief.to_discuss_unavailable", {
      err: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}
