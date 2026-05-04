/**
 * Formats recent Bot Feedback entries from Notion into a markdown
 * few-shot block that gets baked into the cached system prompt for
 * the classifier and extractors.
 *
 * Pure function — no I/O, no env reads, no side effects.
 */

import type { FeedbackEntry } from "../types.js";

const MAX_ENTRIES = 20;
const HEADER = "## Recent feedback (learn from these)";

/**
 * Render up to 20 feedback entries as a markdown block.
 * Returns "" if `entries` is empty so callers can append unconditionally.
 */
export function formatFeedbackAsFewShot(entries: FeedbackEntry[]): string {
  if (entries.length === 0) return "";

  const slice = entries.slice(0, MAX_ENTRIES);
  const lines: string[] = [HEADER, ""];

  for (const entry of slice) {
    lines.push(`- Sender said: "${entry.originalMsg}"`);
    lines.push(`  Bot proposed: ${entry.botExtraction}`);
    lines.push(`  Outcome: ${entry.type} — ${entry.userAction}`);
    if (entry.userText) {
      lines.push(`  User correction: '${entry.userText}'`);
    }
  }

  return lines.join("\n");
}
