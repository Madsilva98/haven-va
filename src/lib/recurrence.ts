import type { ReminderRecurrence } from "../types.js";

export function nextOccurrence(whenIso: string, recurrence: ReminderRecurrence): string {
  const d = new Date(whenIso);
  switch (recurrence) {
    case "diária":
      d.setDate(d.getDate() + 1);
      break;
    case "semanal":
      d.setDate(d.getDate() + 7);
      break;
    case "mensal":
      d.setMonth(d.getMonth() + 1);
      break;
    case "anual":
      // Birthdays + anniversaries. setFullYear handles Feb-29 birthdays
      // correctly: a Feb-29 birthday in a non-leap year rolls forward
      // to Mar-1 (JS Date semantics), which is acceptable here — we'd
      // rather send the reminder a day late than skip the year.
      d.setFullYear(d.getFullYear() + 1);
      break;
    default: {
      // Defense in depth: if a future recurrence value bypasses the type
      // guard at the read site, refuse to silently return the original
      // date (which would re-fire the reminder forever on every 5-min
      // cron tick — see docs/knowledge-base/notion-api-gotchas.md).
      const _exhaustive: never = recurrence;
      throw new Error(`nextOccurrence: unsupported recurrence value: ${String(_exhaustive)}`);
    }
  }
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
