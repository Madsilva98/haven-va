/**
 * Tiny timezone helper. Vercel functions run in UTC; we display
 * everything in Europe/Lisbon. Phase 2 uses simple offset math
 * (UTC+0 winter / UTC+1 summer for Lisbon). Phase 4 will switch
 * to Intl.DateTimeFormat-based logic when we need precise DST.
 */

export class TZDate {
  /**
   * Returns a Date representing the same wall-clock time as `date`
   * in Europe/Lisbon. Use only for week-of-year / day-of-week math
   * — do NOT serialize this as UTC.
   */
  static from(date: Date): Date {
    const lisbon = new Date(
      date.toLocaleString("en-US", { timeZone: "Europe/Lisbon" }),
    );
    return lisbon;
  }
}

export function nowInLisbon(): Date {
  return TZDate.from(new Date());
}

/**
 * Converts a naive "YYYY-MM-DDTHH:mm[:ss]" string, understood as
 * Europe/Lisbon wall-clock time, into a full UTC ISO string ("...Z").
 *
 * Does NOT rely on `process.env.TZ` / V8's local-time parsing — the offset
 * is computed explicitly via Intl, the same way as the rest of this module.
 * This matters because a naive `new Date(str)` parse silently interprets
 * `str` using the process's local timezone; if that ever isn't actually
 * Europe/Lisbon, the "conversion" becomes a no-op and callers store a
 * Lisbon wall-clock value mislabeled as UTC (off by the DST offset).
 */
export function lisbonNaiveToUtcIso(naive: string): string {
  const m = naive.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return naive;
  const [, y, mo, da, h, mi, se] = m as unknown as [
    string, string, string, string, string, string, string | undefined,
  ];
  const guessUtc = new Date(
    Date.UTC(Number(y), Number(mo) - 1, Number(da), Number(h), Number(mi), Number(se ?? "0")),
  );
  const lisbonStr = guessUtc.toLocaleString("en-US", { timeZone: "Europe/Lisbon" });
  const utcStr = guessUtc.toLocaleString("en-US", { timeZone: "UTC" });
  const offsetMs = new Date(lisbonStr).getTime() - new Date(utcStr).getTime();
  return new Date(guessUtc.getTime() - offsetMs).toISOString();
}
