/**
 * Founder Focus weekly-cycle callbacks.
 *
 * Route: focusask:<pageId>:sim | focusask:<pageId>:nao
 *
 * Sent by the Sunday-18:00 cron (`crons/founder-focus-cycle.ts`). Tapping
 * either button records "Cumprido" on the active row, closes the week's
 * cycle (deactivate old row, activate/create next week's), and asks for
 * next week's goals. "Não" first asks "porquê?" — the next free-text DM
 * from that founder is captured as the comment (see `pendingComments`
 * below, consumed by `src/bot/dm.ts`).
 *
 * The "quais são os teus objetivos desta semana?" reply is captured the
 * same way (`pendingGoals`) rather than relying on the conversational
 * assistant to recognize `set_focus` intent from free text — this step is
 * the one thing the whole weekly cycle hinges on, so it shouldn't depend
 * on an LLM tool-choice call picking the right tool for whatever the
 * founder happens to type back.
 *
 * Critically, `pendingGoals` records the EXACT week number the rollover
 * just activated — never recomputed via `weekOfYear()` at answer time.
 * The calendar's current ISO week doesn't change until real midnight
 * Monday, so on a real Sunday-evening "Sim" tap (or in any out-of-band
 * manual test) `weekOfYear()` at reply time can still equal the OLD week,
 * which would make `setFounderFocus` think it's a week-mismatch and spin
 * up a stray extra row instead of filling in the one just activated.
 */

import type { Context } from "grammy";

import { getFounderName, isFounder } from "../lib/founders.js";
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

interface PendingGoals {
  weekNumber: number;
  expiresAt: number;
}

const GOALS_TTL_MS = 24 * 60 * 60 * 1000; // 24h — covers "reply whenever later that day"
const pendingGoals = new Map<number, PendingGoals>();

function gc(): void {
  const now = Date.now();
  for (const [k, v] of pendingComments) {
    if (v.expiresAt < now) pendingComments.delete(k);
  }
  for (const [k, v] of pendingGoals) {
    if (v.expiresAt < now) pendingGoals.delete(k);
  }
}

export function isFocusCallback(data: string): boolean {
  return data.startsWith("focusask:");
}

function markAwaitingGoals(telegramId: number, weekNumber: number): void {
  gc();
  pendingGoals.set(telegramId, { weekNumber, expiresAt: Date.now() + GOALS_TTL_MS });
}

async function closeWeekAndAskGoals(
  ctx: Context,
  telegramId: number,
  founder: FounderName,
  currentWeek: number,
): Promise<void> {
  const nextWeek = currentWeek + 1;
  await notion.rolloverFounderFocusWeek(founder, nextWeek);
  markAwaitingGoals(telegramId, nextWeek);
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
    await closeWeekAndAskGoals(ctx, userId, row.founder, row.weekNumber);
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
  const nextWeek = weekNumber + 1;
  await notion.rolloverFounderFocusWeek(pending.founder, nextWeek);
  markAwaitingGoals(fromId, nextWeek);
  await ctx.reply("quais são os teus objetivos desta semana?");
  log.info("focus_callback.comment_captured", { founder: pending.founder });
  return true;
}

/**
 * Called from `src/bot/dm.ts` before falling through to the assistant.
 * Returns true if the message was consumed as a "quais são os teus
 * objetivos desta semana?" answer.
 */
export async function tryConsumeGoalsAnswer(
  ctx: Context,
  fromId: number,
  text: string,
): Promise<boolean> {
  gc();
  const pending = pendingGoals.get(fromId);
  if (!pending) return false;
  pendingGoals.delete(fromId);

  const founder = getFounderName(fromId);
  if (!founder) return false;

  const foco = text.trim().slice(0, 200);
  await notion.setFounderFocus({ founder, weekNumber: pending.weekNumber, focoOperacional: foco });
  await ctx.reply(`🎯 foco de ${founder} esta semana: "${foco}"`);
  log.info("focus_callback.goals_captured", { founder, weekNumber: pending.weekNumber });
  return true;
}

/**
 * Called by the crons (Sunday-ask keyboard already covers the tap path;
 * this covers the Monday-fallback DM, which has no button to drive
 * `closeWeekAndAskGoals`).
 */
export function markFounderAwaitingGoals(telegramId: number, weekNumber: number): void {
  markAwaitingGoals(telegramId, weekNumber);
}
