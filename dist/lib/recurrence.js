export function nextOccurrence(whenIso, recurrence) {
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
        default: {
            // Defense in depth: if a future recurrence value bypasses the type
            // guard at the read site, refuse to silently return the original
            // date (which would re-fire the reminder forever on every 5-min
            // cron tick — see docs/failure-modes-audit-2026-05-15.md).
            const _exhaustive = recurrence;
            throw new Error(`nextOccurrence: unsupported recurrence value: ${String(_exhaustive)}`);
        }
    }
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
