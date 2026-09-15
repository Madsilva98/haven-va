/**
 * Phase 3 — pipeline alert formatters.
 *
 * All output is pt-PT, "tu", lowercase preferred, terse.
 * Used by the cron pipeline-alerts handler before sending DMs to owners.
 */

import type {
  ContentCalendarNeedsSchedulingRow,
  ReminderRow,
} from "../types.js";

export function formatContentAlert(
  rows: ContentCalendarNeedsSchedulingRow[],
): string {
  const lines: string[] = ["📅 conteúdo por agendar (próx. 2 dias):"];
  for (const row of rows) {
    const date = row.date.slice(0, 10);
    const channel = row.channel ? ` [${row.channel}]` : "";
    lines.push(`• ${row.title} — ${date}${channel} (${row.status})`);
  }
  return lines.join("\n");
}

export function formatReminderMessage(r: ReminderRow): string {
  const lines: string[] = [`⏰ ${r.texto}`];
  if (r.origem && r.origem.trim().length > 0) {
    // single-line context
    const ctx = r.origem.replace(/\s+/g, " ").trim();
    lines.push(`(do que disseste: "${ctx}")`);
  }
  return lines.join("\n");
}
