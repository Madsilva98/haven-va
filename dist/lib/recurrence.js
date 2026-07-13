export function nextOccurrence(whenIso, recurrence) {
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
        case "anual":
            // Birthdays + anniversaries. setUTCFullYear handles Feb-29 birthdays
            // correctly: a Feb-29 birthday in a non-leap year rolls forward
            // to Mar-1 (JS Date semantics), which is acceptable here — we'd
            // rather send the reminder a day late than skip the year.
            d.setUTCFullYear(d.getUTCFullYear() + 1);
            break;
        default: {
            // Defense in depth: if a future recurrence value bypasses the type
            // guard at the read site, refuse to silently return the original
            // date (which would re-fire the reminder forever on every 5-min
            // cron tick — see docs/knowledge-base/notion-api-gotchas.md).
            const _exhaustive = recurrence;
            throw new Error(`nextOccurrence: unsupported recurrence value: ${String(_exhaustive)}`);
        }
    }
    return d.toISOString();
}
