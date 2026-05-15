/**
 * Customer-birthday lookup against the Studio Supabase kenko_customers
 * table. Year-agnostic: matches month+day of date_of_birth against a
 * reference date or range.
 *
 * Used by the daily birthdays cron — see src/crons/birthdays.ts.
 */
import { log } from "./log.js";
import { studioSupabase } from "./studio-supabase.js";
/**
 * Returns the birthdays falling between `from` (inclusive) and
 * `from + daysAhead` (inclusive), sorted by daysUntil ascending.
 *
 * Year-agnostic: a customer born 1985-05-17 matches a search starting
 * 2026-05-15 with daysAhead=7 as daysUntil=2.
 *
 * `from` is interpreted as a calendar date in the local timezone; only
 * its month and day are used for matching.
 */
export async function fetchUpcomingBirthdays(from, daysAhead) {
    if (!studioSupabase) {
        log.warn("birthdays.fetch_skipped", { reason: "studio_supabase_not_configured" });
        return [];
    }
    // Pull every customer with a non-null DOB. The table is small enough
    // (a few hundred to low thousands of rows) that client-side filtering
    // is cheaper than maintaining a stored procedure for month/day extract.
    const { data, error } = await studioSupabase
        .from("kenko_customers")
        .select("contact_name, contact_email, date_of_birth")
        .not("date_of_birth", "is", null);
    if (error) {
        log.error("birthdays.query_failed", { message: error.message, code: error.code });
        throw new Error(`Studio Supabase query failed: ${error.message}`);
    }
    const rows = (data ?? []);
    log.debug("birthdays.rows_fetched", { count: rows.length });
    return filterUpcomingBirthdays(rows, from, daysAhead);
}
/**
 * Pure filter — exported for unit tests.
 *
 * Builds a Set of "MM-DD" strings for the next `daysAhead` days starting
 * at `from` (inclusive). Matches each customer's DOB MM-DD against the
 * set. Annotates each match with `daysUntil`.
 */
export function filterUpcomingBirthdays(rows, from, daysAhead) {
    const pad = (n) => String(n).padStart(2, "0");
    const monthDay = (d) => `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    // Build the day map: MM-DD → daysUntil
    const dayMap = new Map();
    for (let i = 0; i <= daysAhead; i++) {
        const d = new Date(from);
        d.setDate(d.getDate() + i);
        const key = monthDay(d);
        // First occurrence wins (handles the unlikely case of daysAhead >= 365)
        if (!dayMap.has(key))
            dayMap.set(key, i);
    }
    const out = [];
    for (const row of rows) {
        if (!row.date_of_birth)
            continue;
        // Expected format from Postgres DATE: "YYYY-MM-DD"
        const match = row.date_of_birth.match(/^\d{4}-(\d{2})-(\d{2})/);
        if (!match)
            continue;
        const mmdd = `${match[1]}-${match[2]}`;
        const daysUntil = dayMap.get(mmdd);
        if (daysUntil === undefined)
            continue;
        out.push({
            name: row.contact_name?.trim() || row.contact_email,
            email: row.contact_email,
            dateOfBirth: row.date_of_birth.slice(0, 10),
            daysUntil,
        });
    }
    out.sort((a, b) => a.daysUntil - b.daysUntil || a.name.localeCompare(b.name));
    return out;
}
