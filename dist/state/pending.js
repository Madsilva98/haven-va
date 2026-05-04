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
export async function addPending(proposal, chatId) {
    await notion.createPending(proposal, chatId);
}
export async function getPending(botMessageId) {
    return notion.getPending(botMessageId);
}
export async function commitPending(botMessageId, notionPageId) {
    await notion.markCommitted(botMessageId, notionPageId);
}
export async function cancelPending(botMessageId) {
    await notion.markCancelled(botMessageId);
}
export async function getRecentActions(chatId, ttlMinutes = 10, limit = 5) {
    return notion.getRecentActions(chatId, ttlMinutes, limit);
}
