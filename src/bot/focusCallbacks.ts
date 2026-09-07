/**
 * Founder Focus weekly-cycle callbacks.
 *
 * Route: focusask:<pageId>:sim | focusask:<pageId>:nao
 *
 * Sent by the Sunday-18:00 cron (`crons/founder-focus-cycle.ts`). Tapping
 * either button records "Cumprido" on the active row, closes the week's
 * cycle (deactivate old row, activate/create next week's), and asks for
 * next week's goals. "Não" first asks "porquê?" — the next free-text DM
 * from that founder is captured as the comment (see `pendingComment`
 * below, consumed by `src/bot/dm.ts`).
 */

import type { Context } from "grammy";

import { isFounder } from "../lib/founders.js";
import { log } from "../lib/log.js";
import * as notion from "../notion.js";
import type { FounderName } from "../types.js";

interface PendingComment {
  pageId: string;
  founder: FounderName;
  expiresAt: number;
}

const PENDING_TTL_MS = 2 * 60 * 60 * 1000; // 2h — same-session follow-up, not meant to survive long
const pendingComments = new Map<number, PendingComment>();

function gc(): void {
  const now = Date.now();
  for (const [k, v] of pendingComments) {
    if (v.expiresAt < now) pendingComments.delete(k);
  }
}

export function isFocusCallback(data: string): boolean {
  return data.startsWith("focusask:");
}

async function closeWeekAndAskGoals(ctx: Context, founder: FounderName, currentWeek: number): Promise<void> {
  await notion.rolloverFounderFocusWeek(founder, currentWeek + 1);
  await ctx.reply("quais são os teus objetivos desta semana?");
}

export async function handleFocusCallback(ctx: Context): Promise<void> {
  const query = ctx.callbackQuery;
  const data = query?.data;
  const userId = query?.from.id;
  if (!data || userId === undefined) {
    await ctx.answerCallbackQuery();
    return;
  }
  if (!isFounder(userId)) {
    await ctx.answerCallbackQuery({ text: "só founders podem responder" });
    return;
  }

  const parts = data.split(":");
  const pageId = parts[1];
  const answer = parts[2];
  if (!pageId || (answer !== "sim" && answer !== "nao")) {
    await ctx.answerCallbackQuery();
    return;
  }

  const row = await notion.getFounderFocusRow(pageId);
  if (!row) {
    await ctx.answerCallbackQuery({ text: "não encontrei essa linha" });
    return;
  }
  if (!row.ativo) {
    // Already rolled over from a previous tap (double-tap guard).
    await ctx.answerCallbackQuery({ text: "já respondido" });
    try {
      await ctx.editMessageReplyMarkup({ reply_markup: undefined });
    } catch {
      // message may be too old to edit — ignore
    }
    return;
  }

  await ctx.answerCallbackQuery();
  try {
    await ctx.editMessageReplyMarkup({ reply_markup: undefined });
  } catch {
    // ignore
  }

  if (answer === "sim") {
    await notion.setFounderFocusCumprido(pageId, true);
    await ctx.reply("👍");
    await closeWeekAndAskGoals(ctx, row.founder, row.weekNumber);
    return;
  }

  await notion.setFounderFocusCumprido(pageId, false);
  gc();
  pendingComments.set(userId, {
    pageId,
    founder: row.founder,
    expiresAt: Date.now() + PENDING_TTL_MS,
  });
  await ctx.reply("porquê?");
}

/**
 * Called from `src/bot/dm.ts` before falling through to the assistant.
 * Returns true if the message was consumed as a "porquê?" answer.
 */
export async function tryConsumeFocusComment(
  ctx: Context,
  fromId: number,
  text: string,
): Promise<boolean> {
  gc();
  const pending = pendingComments.get(fromId);
  if (!pending) return false;
  pendingComments.delete(fromId);

  await notion.setFounderFocusCumprido(pending.pageId, false, text.trim());
  const row = await notion.getFounderFocusRow(pending.pageId);
  const weekNumber = row?.weekNumber ?? 0;
  await notion.rolloverFounderFocusWeek(pending.founder, weekNumber + 1);
  await ctx.reply("quais são os teus objetivos desta semana?");
  log.info("focus_callback.comment_captured", { founder: pending.founder });
  return true;
}
