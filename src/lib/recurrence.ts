import type { ReminderRecurrence } from "../types.js";

export function nextOccurrence(whenIso: string, recurrence: ReminderRecurrence): string {
  // UTC-only arithmetic + toISOString(): keeps the stored value an
  // unambiguous absolute UTC instant, matching every other writer of
  // Quando. Building this from local getters (getHours, no "Z") used to
  // relabel Lisbon wall-clock as UTC, delaying every 2nd+ recurring fire
  // by the DST offset.
  const d = new Date(whenIso);
  switch (recurrence) {
    case "diária":
      d.setUTCDate(d.getUTCDate() + 1);
      break;
    case "semanal":
      d.setUTCDate(d.getUTCDate() + 7);
      break;
    case "mensal":
      d.setUTCMonth(d.getUTCMonth() + 1);
      break;
    default: {
      // Defense in depth: if a future recurrence value bypasses the type
      // guard at the read site, refuse to silently return the original
      // date (which would re-fire the reminder forever on every 5-min
      // cron tick — see docs/failure-modes-audit-2026-05-15.md).
      const _exhaustive: never = recurrence;
      throw new Error(`nextOccurrence: unsupported recurrence value: ${String(_exhaustive)}`);
    }
  }
  return d.toISOString();
}
