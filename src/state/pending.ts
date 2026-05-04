/**
 * Pending proposal store — backed by the Bot Pending Notion DB.
 *
 * Each row is created when the bot proposes an action and goes through
 * one of two terminal states: Committed (user confirmed) or Cancelled
 * (user dropped it). Rows are NOT archived after either — they remain
 * queryable for ~10 minutes so the multi-intent extractor can read
 * them as "recent bot actions" context.
 *
 * Lookup semantics:
 *   - getPending(botMessageId)       → returns proposal only if neither
 *                                      Committed nor Cancelled.
 *   - getRecentActions(chatId, ttl)  → returns committed + pending,
 *                                      excludes cancelled.
 */

import * as notion from "../notion.js";
import type { PendingProposal, RecentAction } from "../types.js";

export async function addPending(
  proposal: PendingProposal,
  chatId: number,
): Promise<void> {
  await notion.createPending(proposal, chatId);
}

export async function getPending(
  botMessageId: number,
): Promise<PendingProposal | null> {
  return notion.getPending(botMessageId);
}

export async function commitPending(
  botMessageId: number,
  notionPageId: string | null,
): Promise<void> {
  await notion.markCommitted(botMessageId, notionPageId);
}

export async function cancelPending(botMessageId: number): Promise<void> {
  await notion.markCancelled(botMessageId);
}

export async function getRecentActions(
  chatId: number,
  ttlMinutes = 10,
  limit = 5,
): Promise<RecentAction[]> {
  return notion.getRecentActions(chatId, ttlMinutes, limit);
}
