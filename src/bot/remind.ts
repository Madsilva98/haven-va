/**
 * Phase 3 — `/remind` command + natural-language "avisa-me daqui a X".
 *
 * Two entry points:
 * - `parseRemindCommand(text, sender)` — pure parser, no I/O.
 * - `handleRemind(ctx)` — grammy handler that creates the Notion row
 *   and confirms in chat.
 *
 * Supported patterns (all pt-PT):
 *   /remind 2h <texto>           → fires in 2 hours
 *   /remind 30m <texto>          → fires in 30 minutes
 *   /remind 1d <texto>           → fires in 1 day, same hour
 *   /remind 1w <texto>           → fires in 1 week, same hour
 *   /remind amanhã <texto>       → fires tomorrow at 09:00
 *   /remind sexta <texto>        → fires next Friday at 09:00
 *   "avisa-me daqui a 2h <texto>" — same offsets, no slash
 *
 * Supported units: m (min), h (hours), d (days), w (weeks).
 * Day names (pt-PT): segunda, terça, quarta, quinta, sexta, sábado, domingo.
 */

import type { Context } from "grammy";

import { getFounderName } from "../lib/founders.js";
import { log } from "../lib/log.js";
import * as notion from "../notion.js";
import type { FounderName, ReminderRow } from "../types.js";

interface ParseResult {
  parsed: boolean;
  reminder?: Omit<ReminderRow, "id" | "enviado">;
  whenLabel?: string;
}

const DAY_NAMES_PT: Record<string, number> = {
  // 0 = Sunday … 6 = Saturday (matches Date.getDay())
  domingo: 0,
  segunda: 1,
  "segunda-feira": 1,
  terça: 2,
  "terca": 2,
  "terça-feira": 2,
  "terca-feira": 2,
  quarta: 3,
  "quarta-feira": 3,
  quinta: 4,
  "quinta-feira": 4,
  sexta: 5,
  "sexta-feira": 5,
  "sábado": 6,
  sabado: 6,
};

function stripCommand(text: string): string {
  // Removes "/remind" or "/remind@bot" prefix, plus optional natural-language
  // prefix "avisa-me daqui a" / "avisa-me amanhã" / etc.
  let stripped = text.replace(/^\/remind(@\w+)?\s*/i, "");
  if (stripped === text) {
    // No slash command — try natural form.
    stripped = stripped.replace(/^avisa[-\s]?me\s+(daqui\s+a\s+)?/i, "");
  }
  return stripped.trim();
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function isoLocal(date: Date): string {
  // Returns "YYYY-MM-DDTHH:mm:ss" with no Z — Notion accepts naive datetimes
  // and we do all scheduling in Lisbon wall-clock for now (Phase 4 will
  // swap to TZ-aware logic).
  const y = date.getFullYear();
  const m = pad2(date.getMonth() + 1);
  const d = pad2(date.getDate());
  const hh = pad2(date.getHours());
  const mm = pad2(date.getMinutes());
  const ss = pad2(date.getSeconds());
  return `${y}-${m}-${d}T${hh}:${mm}:${ss}`;
}

function describeWhen(target: Date): string {
  // Short pt-PT label, e.g. "amanhã às 09:00" or "30/04 às 14:30".
  const now = new Date();
  const sameDay =
    target.getFullYear() === now.getFullYear() &&
    target.getMonth() === now.getMonth() &&
    target.getDate() === now.getDate();
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  const isTomorrow =
    target.getFullYear() === tomorrow.getFullYear() &&
    target.getMonth() === tomorrow.getMonth() &&
    target.getDate() === tomorrow.getDate();
  const time = `${pad2(target.getHours())}:${pad2(target.getMinutes())}`;
  if (sameDay) return `hoje às ${time}`;
  if (isTomorrow) return `amanhã às ${time}`;
  return `${pad2(target.getDate())}/${pad2(target.getMonth() + 1)} às ${time}`;
}

function nextDayOfWeek(now: Date, targetDow: number): Date {
  // Returns next occurrence of targetDow at 09:00, strictly in the future.
  const result = new Date(now);
  result.setHours(9, 0, 0, 0);
  const currentDow = now.getDay();
  let delta = (targetDow - currentDow + 7) % 7;
  if (delta === 0) delta = 7; // strictly future
  result.setDate(result.getDate() + delta);
  return result;
}

function tomorrow9am(now: Date): Date {
  const t = new Date(now);
  t.setDate(now.getDate() + 1);
  t.setHours(9, 0, 0, 0);
  return t;
}

/**
 * Pure parser. Returns `{parsed: false}` if the text does not match any
 * supported pattern.
 */
export function parseRemindCommand(
  text: string,
  sender: FounderName,
): ParseResult {
  const body = stripCommand(text);
  if (body.length === 0) return { parsed: false };

  // Split first whitespace-separated token from the rest.
  const match = body.match(/^(\S+)\s+(.+)$/s);
  if (!match) return { parsed: false };
  const [, headRaw, rest] = match as [string, string, string];
  const head = headRaw.toLowerCase();
  const message = rest.trim();
  if (message.length === 0) return { parsed: false };

  const now = new Date();
  let target: Date | null = null;

  // 1. Offset form: 30m / 2h / 1d / 1w
  const offset = head.match(/^(\d+)([mhdw])$/);
  if (offset) {
    const value = Number(offset[1]);
    const unit = offset[2];
    target = new Date(now);
    if (unit === "m") target.setMinutes(target.getMinutes() + value);
    else if (unit === "h") target.setHours(target.getHours() + value);
    else if (unit === "d") target.setDate(target.getDate() + value);
    else if (unit === "w") target.setDate(target.getDate() + value * 7);
  }

  // 2. "amanhã" → tomorrow 09:00
  if (!target && (head === "amanhã" || head === "amanha")) {
    target = tomorrow9am(now);
  }

  // 3. Day-of-week → next occurrence at 09:00
  if (!target && head in DAY_NAMES_PT) {
    const dow = DAY_NAMES_PT[head]!;
    target = nextDayOfWeek(now, dow);
  }

  if (!target) return { parsed: false };

  return {
    parsed: true,
    reminder: {
      texto: message,
      paraQuem: sender,
      quando: isoLocal(target),
      origem: text,
    },
    whenLabel: describeWhen(target),
  };
}

const USAGE_HELP =
  "uso: /remind <quando> <texto>\n" +
  "exemplos:\n" +
  "• /remind 2h ligar à madalena\n" +
  "• /remind amanhã rever pipeline\n" +
  "• /remind sexta enviar relatório\n" +
  "• /remind 1w follow-up parceria";

export async function handleRemind(ctx: Context): Promise<void> {
  const text = ctx.message?.text ?? "";
  const senderId = ctx.from?.id;
  if (!senderId) return;
  const senderName = getFounderName(senderId);
  if (!senderName) return;

  const result = parseRemindCommand(text, senderName);
  if (!result.parsed || !result.reminder) {
    await ctx.reply(USAGE_HELP);
    return;
  }

  try {
    await notion.createReminder(result.reminder);
    await ctx.reply(`✅ apito-te ${result.whenLabel}: ${result.reminder.texto}`);
  } catch (err) {
    log.error("remind.create_failed", {
      message: err instanceof Error ? err.message : String(err),
    });
    await ctx.reply("erro a criar o lembrete — tenta outra vez");
  }
}

/**
 * Free-text reminder handler — called by the multi-intent router when
 * the extractor emits a REMINDER intent. Bypasses /remind syntax: the
 * extractor has already resolved the date to ISO and the target.
 */
export async function createReminderFromIntent(
  tgCtx: Context,
  sender: FounderName,
  intent: { when: string; text: string; for: FounderName | "all" },
): Promise<void> {
  const target: FounderName = intent.for === "all" ? sender : intent.for;
  try {
    await notion.createReminder({
      texto: intent.text,
      paraQuem: target,
      quando: intent.when,
      origem: tgCtx.message?.text ?? "",
    });
    const when = new Date(intent.when).toLocaleString("pt-PT", {
      timeZone: "Europe/Lisbon",
      weekday: "long",
      hour: "2-digit",
      minute: "2-digit",
    });
    await tgCtx.reply(`⏰ lembrete: ${when} — ${intent.text}`);
  } catch (err) {
    log.error("remind.create_from_intent_failed", {
      message: err instanceof Error ? err.message : String(err),
    });
  }
}
