/**
 * "Which view did that number come from?" — the memory behind two things
 * the spec asks for (docs/plans/2026-09-21-pulse-views-spec.md, steps 3-4):
 * every number the bot posts ends with a "Fonte: v_pulse_…" line, and
 * "porquê?" / "/flag" pick up the view named in the message being replied
 * to, else the last one named in that chat.
 */

import { sendGroupMessage } from "./telegram.js";

const lastSourceByChat = new Map<number, string[]>();

function formatDatePt(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split("-");
  return `${d}/${m}/${y}`;
}

export function formatSourceLine(views: string[], asOf?: string | null): string {
  const base = `Fonte: ${views.join(", ")}`;
  return asOf ? `${base} · dados até ${formatDatePt(asOf)}` : base;
}

export function extractViewsFromText(text: string | undefined | null): string[] {
  const m = text?.match(/^Fonte:\s*(.+)$/m);
  if (!m?.[1]) return [];
  return m[1]
    .split("·")[0]!
    .split(",")
    .map((s) => s.trim())
    .filter((s) => /^v_pulse_[a-z_]+$/.test(s));
}

export function rememberSource(chatId: number, views: string[]): void {
  if (views.length > 0) lastSourceByChat.set(chatId, views);
}

export function lastSource(chatId: number): string[] {
  return lastSourceByChat.get(chatId) ?? [];
}

/**
 * "porquê?", "porque?", "por que?", "e porquê?", "why?" — the bare question
 * only, so a real sentence still goes to the assistant.
 */
export function isWhyQuestion(text: string): boolean {
  return /^\s*(e\s+)?(porqu[eê]|por\s+que|why)\s*[?？!]*\s*$/i.test(text);
}

/**
 * sendGroupMessage + the spec's "name the view it came from" line, and
 * remember it so "porquê?" / "/flag" in the group can find it.
 * `pendingNote` is for a digest whose numbers still partly come from an
 * allowlisted raw read — say so, with the pulse_cases id.
 */
export async function sendGroupMessageWithSource(
  text: string,
  views: string[],
  asOf?: string | null,
  pendingNote?: string,
): Promise<number> {
  const tail = [formatSourceLine(views, asOf), pendingNote].filter(Boolean).join("\n");
  const id = await sendGroupMessage(`${text}\n\n${tail}`, undefined);
  const groupId = Number(process.env.TELEGRAM_GROUP_ID);
  if (groupId) rememberSource(groupId, views);
  return id;
}
