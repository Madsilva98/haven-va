import type { Birthday } from "../lib/birthdays.js";

/**
 * Format the daily 08:00 birthday digest — birthdays TODAY only (the
 * cron calls fetchUpcomingBirthdays with daysAhead=0, so every entry
 * here already has daysUntil === 0). No upcoming-week preview — dropped
 * 2026-09-15, founder's call.
 *
 * Returns `null` if there's nobody to announce, so the cron can skip
 * sending — no point waking the group for nothing.
 */
export function formatBirthdayDigest(birthdays: Birthday[]): string | null {
  if (birthdays.length === 0) return null;

  const lines: string[] = ["🎂 *Hoje é aniversário de:*"];
  for (const b of birthdays) {
    lines.push(`• ${b.name}`);
  }
  return lines.join("\n");
}
