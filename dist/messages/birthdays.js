const WEEKDAY_PT = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];
function formatDateLabel(daysUntil, dateOfBirth) {
    // dateOfBirth is the customer's actual DOB (year may be old). We want
    // the upcoming occurrence's weekday + dd/mm.
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const occurrence = new Date(today);
    occurrence.setDate(today.getDate() + daysUntil);
    const dd = String(occurrence.getDate()).padStart(2, "0");
    const mm = String(occurrence.getMonth() + 1).padStart(2, "0");
    const weekday = WEEKDAY_PT[occurrence.getDay()];
    return `${weekday}, ${dd}/${mm}`;
}
/**
 * Format the daily 08:00 birthday digest. Single message split into two
 * sections:
 *   🎂 Hoje  — birthdays today (daysUntil === 0)
 *   📅 Esta semana — birthdays daysUntil 1..7
 *
 * If there are zero birthdays in the next 7 days, returns `null` so the
 * cron can skip sending — no point waking the group for nothing.
 */
export function formatBirthdayDigest(birthdays) {
    if (birthdays.length === 0)
        return null;
    const today = birthdays.filter((b) => b.daysUntil === 0);
    const upcoming = birthdays.filter((b) => b.daysUntil >= 1 && b.daysUntil <= 7);
    if (today.length === 0 && upcoming.length === 0)
        return null;
    const lines = [];
    if (today.length > 0) {
        lines.push("🎂 *Hoje é aniversário de:*");
        for (const b of today) {
            lines.push(`• ${b.name}`);
        }
    }
    if (upcoming.length > 0) {
        if (lines.length > 0)
            lines.push("");
        lines.push("📅 *Esta semana:*");
        for (const b of upcoming) {
            lines.push(`• ${b.name} — ${formatDateLabel(b.daysUntil, b.dateOfBirth)}`);
        }
    }
    return lines.join("\n");
}
