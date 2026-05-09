import type { FounderName } from "../types.js";

const RECENT_MAX = 6;
export const recentByChat = new Map<number, { sender: FounderName; text: string }[]>();
export const lastBotRepliesByChat = new Map<number, string[]>();

export function pushRecent(chatId: number, sender: FounderName, text: string): void {
  const arr = recentByChat.get(chatId) ?? [];
  arr.push({ sender, text });
  while (arr.length > RECENT_MAX) arr.shift();
  recentByChat.set(chatId, arr);
}

export function getPriors(chatId: number): { sender: FounderName; text: string }[] {
  const arr = recentByChat.get(chatId) ?? [];
  return arr.slice(0, -1).slice(-5);
}
