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
import type { FounderName, ReminderRecurrence, ReminderRow } from "../types.js";

interface ParseResult {
  parsed: boolean;
  reminder?: Omit<ReminderRow, "id" | "enviado">;
  whenLabel?: string;
}

const RECURRENCE_PATTERNS: Array<[RegExp, ReminderRecurrence]> = [
  [/\btodos\s+os\s+dias\b|\bdiariamente\b|\btodo\s+o\s+dia\b/i, "diária"],
  [/\btoda\s+(a\s+)?semana\b|\btodas\s+as\s+semanas\b|\bsemanalmente\b/i, "semanal"],
  [/\btodo\s+o\s+m[eê]s\b|\btodos\s+os\s+meses\b|\bmensalmente\b/i, "mensal"],
];

function extractRecurrence(text: string): { text: string; recurrence?: ReminderRecurrence } {
  for (const [re, recurrence] of RECURRENCE_PATTERNS) {
    if (re.test(text)) {
      const cleaned = text.replace(re, " ").trim().replace(/\s{2,}/g, " ");
      return { text: cleaned, recurrence };
    }
  }
  return { text };
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

function lisbonOffsetMs(d: Date): number {
  // Returns Europe/Lisbon offset relative to UTC in ms (positive = ahead of UTC).
  const lisbonStr = d.toLocaleString("en-US", { timeZone: "Europe/Lisbon" });
  const utcStr = d.toLocaleString("en-US", { timeZone: "UTC" });
  return new Date(lisbonStr).getTime() - new Date(utcStr).getTime();
}

function at9amLisbon(approxDate: Date): Date {
  // Returns the real UTC Date representing 09:00:00 Europe/Lisbon on the same
  // Lisbon calendar day as approxDate. approxDate should be near UTC midnight.
  const lisbonFake = new Date(
    approxDate.toLocaleString("en-US", { timeZone: "Europe/Lisbon" }),
  );
  lisbonFake.setHours(9, 0, 0, 0);
  const offsetMs = lisbonOffsetMs(approxDate);
  return new Date(lisbonFake.getTime() - offsetMs);
}

function describeWhen(target: Date): string {
  // Short pt-PT label showing Lisbon wall-clock time, e.g. "amanhã às 09:00" or "30/04 às 14:30".
  const now = new Date();
  // Compare calendar days using Lisbon wall-clock components via the toLocaleString fake-date trick.
  const tFake = new Date(target.toLocaleString("en-US", { timeZone: "Europe/Lisbon" }));
  const nFake = new Date(now.toLocaleString("en-US", { timeZone: "Europe/Lisbon" }));
  const tomFake = new Date(nFake);
  tomFake.setDate(nFake.getDate() + 1);
  const sameDay =
    tFake.getFullYear() === nFake.getFullYear() &&
    tFake.getMonth() === nFake.getMonth() &&
    tFake.getDate() === nFake.getDate();
  const isTomorrow =
    tFake.getFullYear() === tomFake.getFullYear() &&
    tFake.getMonth() === tomFake.getMonth() &&
    tFake.getDate() === tomFake.getDate();
  const time = target.toLocaleString("pt-PT", {
    timeZone: "Europe/Lisbon",
    hour: "2-digit",
    minute: "2-digit",
  });
  if (sameDay) return `hoje às ${time}`;
  if (isTomorrow) return `amanhã às ${time}`;
  return `${pad2(tFake.getDate())}/${pad2(tFake.getMonth() + 1)} às ${time}`;
}

function nextDayOfWeek(now: Date, targetDow: number): Date {
  // Returns next occurrence of targetDow at 09:00 Europe/Lisbon, strictly in the future.
  const result = new Date(now);
  result.setHours(0, 0, 0, 0); // UTC midnight — used as approx anchor for at9amLisbon
  const currentDow = now.getDay();
  let delta = (targetDow - currentDow + 7) % 7;
  if (delta === 0) delta = 7; // strictly future
  result.setDate(result.getDate() + delta);
  return at9amLisbon(result);
}

function tomorrow9am(now: Date): Date {
  const t = new Date(now);
  t.setDate(now.getDate() + 1);
  t.setHours(0, 0, 0, 0);
  return at9amLisbon(t);
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
  const head = headRaw.normalize("NFC").toLowerCase();
  const { text: message, recurrence } = extractRecurrence(rest.trim());
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

  const recurrenceLabel =
    recurrence === "diária" ? " (repete todos os dias)"
    : recurrence === "semanal" ? " (repete toda a semana)"
    : recurrence === "mensal" ? " (repete todo o mês)"
    : "";

  return {
    parsed: true,
    reminder: {
      texto: message,
      paraQuem: sender,
      quando: isoLocal(target),
      origem: text,
      recurrence,
    },
    whenLabel: `${describeWhen(target)}${recurrenceLabel}`,
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
  const targets: FounderName[] =
    intent.for === "all" ? ["Madalena", "Mafalda", "Beatriz"] : [intent.for];
  const origem = tgCtx.message?.text ?? "";
  try {
    await Promise.all(
      targets.map((paraQuem) =>
        notion.createReminder({ texto: intent.text, paraQuem, quando: intent.when, origem }),
      ),
    );
    const when = new Date(intent.when).toLocaleString("pt-PT", {
      timeZone: "Europe/Lisbon",
      weekday: "long",
      day: "numeric",
      month: "long",
      hour: "2-digit",
      minute: "2-digit",
    });
    const whoLabel = intent.for === "all" ? "todas" : intent.for;
    await tgCtx.reply(`⏰ lembrete para ${whoLabel}: ${when} — ${intent.text}`);
  } catch (err) {
    log.error("remind.create_from_intent_failed", {
      message: err instanceof Error ? err.message : String(err),
    });
  }
}
