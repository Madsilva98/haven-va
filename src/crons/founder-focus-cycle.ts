/**
 * Founder Focus weekly cycle — Sunday ask + Monday fallback.
 *
 * Sunday 18:00 (`runSundayAsk`): every founder whose active row is still
 * this week's and hasn't answered "Cumprido" yet gets "Objetivos da semana:
 * {foco}. cumpriste?" with Sim/Não buttons. Tapping either (handled in
 * `src/bot/focusCallbacks.ts`) closes the week's cycle immediately.
 *
 * Monday 08:00 (`runMondayReask`): whoever's active row still points at
 * last week (i.e. never got closed — the founder didn't tap Sunday) gets
 * the cycle closed here directly, `Cumprido` left blank (filled manually
 * later if at all), and is asked "quais são os teus objetivos desta
 * semana?" straight away — no re-asking Sim/Não.
 *
 * Both take `now` so they're testable without waiting for the real day.
 */

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

export async function runSundayAsk(now: Date = new Date()): Promise<void> {
  const currentWeek = weekOfYear(now);
  const active = await notion.getActiveFounderFocuses();
  let sent = 0;
  for (const entry of active) {
    if (entry.weekNumber !== currentWeek) continue;
    const tgId = getTelegramId(entry.founder);
    if (tgId === null) {
      log.warn("cron.focus_cycle.sunday.no_telegram_id", { founder: entry.founder });
      continue;
    }
    const pageId = await notion.getOrCreateFounderFocusRow(entry.founder, currentWeek, { activate: false });
    const text = `Objetivos da semana: ${entry.focoOperacional || "(sem foco definido)"}. cumpriste?`;
    try {
      await sendDM(tgId, text, undefined, focusAskKeyboard(pageId));
      sent++;
    } catch (err) {
      log.warn("cron.focus_cycle.sunday.dm_failed", {
        founder: entry.founder,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
  log.info("cron.focus_cycle.sunday_asked", { sent });
}

export async function runMondayReask(now: Date = new Date()): Promise<void> {
  const currentWeek = weekOfYear(now);
  const active = await notion.getActiveFounderFocuses();
  let closed = 0;
  for (const entry of active) {
    if (entry.weekNumber === currentWeek) continue; // already rolled over (Sunday tap)
    await rolloverAndAsk(entry.founder, currentWeek);
    closed++;
  }
  log.info("cron.focus_cycle.monday_rolled_over", { closed });
}

async function rolloverAndAsk(founder: FounderName, nextWeek: number): Promise<void> {
  await notion.rolloverFounderFocusWeek(founder, nextWeek);
  const tgId = getTelegramId(founder);
  if (tgId === null) {
    log.warn("cron.focus_cycle.monday.no_telegram_id", { founder });
    return;
  }
  try {
    await sendDM(tgId, "quais são os teus objetivos desta semana?");
  } catch (err) {
    log.warn("cron.focus_cycle.monday.dm_failed", {
      founder,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}
