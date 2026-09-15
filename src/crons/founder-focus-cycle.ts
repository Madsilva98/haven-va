/**
 * Founder Focus weekly cycle — personal check-in paired with the team's
 * meeting-triggered messages, not a fixed day/time of its own.
 *
 * `runFocusCumpridoAsk`: called from `founder-meeting-balance-check.ts`
 * whenever it sends week-balance (morning of the Founders Meeting, or its
 * Sunday fallback). Every founder with an active, not-yet-answered focus
 * row gets "Objetivos da semana: {foco}. cumpriste?" with Sim/Não buttons.
 * Tapping either (handled in `src/bot/focusCallbacks.ts`) closes the
 * week's cycle immediately.
 *
 * `runFocusRollover`: called from `founder-meeting-check.ts` whenever it
 * sends weekly-priorities (morning after the meeting, or its Monday
 * fallback). Whoever's active row still points at the previous week (i.e.
 * never got closed by a "cumpriste?" tap) gets the cycle closed here
 * directly, `Cumprido` left blank (filled manually later if at all), and
 * is asked "quais são os teus objetivos desta semana?" straight away — no
 * re-asking Sim/Não.
 *
 * Both take `now` — matching the two meeting-check crons that call
 * them — so they're testable without waiting for the real day, and so a
 * single `now` snapshot drives both the team message and the personal ask
 * together.
 */

import { markFounderAwaitingGoals } from "../bot/focusCallbacks.js";
import { getTelegramId } from "../lib/founders.js";
import { log } from "../lib/log.js";
import { sendDM, type InlineKeyboardMarkup } from "../lib/telegram.js";
import { weekOfYear } from "../lib/week.js";
import * as notion from "../notion.js";
import type { FounderName } from "../types.js";

function focusAskKeyboard(pageId: string): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: "✅ Sim", callback_data: `focusask:${pageId}:sim` },
        { text: "❌ Não", callback_data: `focusask:${pageId}:nao` },
      ],
    ],
  };
}

export async function runFocusCumpridoAsk(now: Date = new Date()): Promise<void> {
  const currentWeek = weekOfYear(now);
  const active = await notion.getActiveFounderFocuses();
  let sent = 0;
  for (const entry of active) {
    // No week-number filter here on purpose: getActiveFounderFocuses()
    // already returns exactly the one row per founder that hasn't been
    // rolled over yet — that row IS the one to ask about, regardless of
    // whether "today" happens to already be a new ISO week. An earlier
    // version skipped when entry.weekNumber !== currentWeek, which was
    // only safe under a fixed Sunday-only schedule; once this trigger can
    // fire on any weekday (whenever the Founders Meeting or its fallback
    // lands), that filter would silently skip founders whenever the
    // trigger fires on the first day of a new ISO week.
    const tgId = getTelegramId(entry.founder);
    if (tgId === null) {
      log.warn("cron.focus_cycle.ask.no_telegram_id", { founder: entry.founder });
      continue;
    }
    const pageId = await notion.getOrCreateFounderFocusRow(entry.founder, entry.weekNumber, { activate: false });
    const text = `Objetivos da semana: ${entry.focoOperacional || "(sem foco definido)"}. cumpriste?`;
    try {
      await sendDM(tgId, text, undefined, focusAskKeyboard(pageId));
      sent++;
    } catch (err) {
      log.warn("cron.focus_cycle.ask.dm_failed", {
        founder: entry.founder,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
  log.info("cron.focus_cycle.asked", { sent, currentWeek });
}

export async function runFocusRollover(now: Date = new Date()): Promise<void> {
  const currentWeek = weekOfYear(now);
  const active = await notion.getActiveFounderFocuses();
  let closed = 0;
  for (const entry of active) {
    if (entry.weekNumber === currentWeek) continue; // already rolled over (tapped Sim/Não)
    await rolloverAndAsk(entry.founder, currentWeek);
    closed++;
  }
  log.info("cron.focus_cycle.rolled_over", { closed });
}

async function rolloverAndAsk(founder: FounderName, nextWeek: number): Promise<void> {
  await notion.rolloverFounderFocusWeek(founder, nextWeek);
  const tgId = getTelegramId(founder);
  if (tgId === null) {
    log.warn("cron.focus_cycle.rollover.no_telegram_id", { founder });
    return;
  }
  try {
    markFounderAwaitingGoals(tgId, nextWeek);
    await sendDM(tgId, "quais são os teus objetivos desta semana?");
  } catch (err) {
    log.warn("cron.focus_cycle.rollover.dm_failed", {
      founder,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}
