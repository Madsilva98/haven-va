/**
 * Builds and sends the weekly priorities message (group post + per-founder
 * DMs) right now. Used to be a fixed Monday-08:00 cron; as of 2026-09 the
 * *decision* of when to call this lives in `founder-meeting-check.ts`
 * instead, which fires this the morning after the "Founders Meeting"
 * calendar event (where priorities/foco actually get set), falling back to
 * Monday only if no such meeting is scheduled that week. This file only
 * knows how to send the message, not when.
 */
import { getTelegramId } from "../lib/founders.js";
import { log } from "../lib/log.js";
import { sendDM, sendGroupMessage } from "../lib/telegram.js";
import { currentWeekLabel, weekOfYear } from "../lib/week.js";
import {
  formatDailyMadalenaPlaceholder,
  formatMondayPriorities,
} from "../messages/cycle.js";
import * as notion from "../notion.js";
import type { FounderFocusEntry, FounderName, OpenTask } from "../types.js";

const FOUNDERS: FounderName[] = ["Madalena", "Mafalda", "Beatriz"];

export async function run(): Promise<void> {
  const weekLabel = currentWeekLabel();
  const [priorities, focus] = await Promise.all([
    notion.getWeeklyPriorities(weekLabel),
    safeFounderFocus(weekOfYear()),
  ]);

  const prioritiesByFounder: Record<FounderName, OpenTask[]> = {
    Madalena: [],
    Mafalda: [],
    Beatriz: [],
  };
  for (const t of priorities) {
    if (
      t.owner === "Madalena" ||
      t.owner === "Mafalda" ||
      t.owner === "Beatriz"
    ) {
      prioritiesByFounder[t.owner].push(t);
    }
  }

  const groupText = formatMondayPriorities({ weekLabel, prioritiesByFounder, focus });
  const groupMsgId = await sendGroupMessage(groupText, "MarkdownV2");

  let dmsSent = 0;
  for (const founder of FOUNDERS) {
    const tgId = getTelegramId(founder);
    if (tgId === null) {
      log.warn("cron.monday.no_telegram_id", { founder });
      continue;
    }
    const dmText = formatDailyMadalenaPlaceholder({ tasks: prioritiesByFounder[founder] });
    try {
      await sendDM(tgId, dmText, "MarkdownV2");
      dmsSent++;
    } catch (err) {
      log.warn("cron.monday.dm_failed", {
        founder,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  log.info("cron.monday_priorities.posted", {
    groupMsgId,
    dmsSent,
    priorities: priorities.length,
  });
}

async function safeFounderFocus(weekNumber: number): Promise<FounderFocusEntry[]> {
  try {
    return await notion.getFounderFocusForWeek(weekNumber);
  } catch (err) {
    log.warn("cron.monday_priorities.focus_unavailable", {
      err: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}
