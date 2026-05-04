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
