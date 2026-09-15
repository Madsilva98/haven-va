/**
 * Customer-birthday lookup against the Studio Supabase kenko_customers
 * table. Year-agnostic: matches month+day of date_of_birth against a
 * reference date or range.
 *
 * Only customers with an active membership or active credit pack are
 * included — kenko_customers has no active/inactive flag of its own and
 * includes Leads alongside real customers, so without this filter the
 * digest would wish happy birthday to leads and churned customers too
 * (confirmed for real, 2026-09-16 — see docs/knowledge-base/
 * bot-architecture.md). Active intro-pack holders are a real third
 * category the founders want included too, but the only source for that
 * (a Supabase view keyed by an opaque member_id with no discoverable
 * mapping back to contact_email/kenko_customers) can't be joined against
 * anything else in this database — deliberately deferred, not forgotten.
 *
 * Used by the daily birthdays cron — see src/crons/birthdays.ts.
 */

import { log } from "./log.js";
import { studioSupabase } from "./studio-supabase.js";

// membership_type values seen on kenko_memberships besides these two:
// null (used for add-on "Top-up" packs, not a standalone active state —
// deliberately excluded, not an oversight).
const ACTIVE_MEMBERSHIP_TYPES = ["Subscription", "Credit pack"];

/**
 * Every contact_email with a currently active membership (recurring
 * subscription or a standalone "Subscription"-type membership row) or an
 * active credit pack, lowercased. Two tables because kenko_subscriptions
 * (billing/recurring) and kenko_memberships (broader grant records,
 * including credit packs) aren't the same data — a Set naturally
 * dedupes any real overlap between them.
 */
async function fetchActiveContactEmails(): Promise<Set<string>> {
  if (!studioSupabase) return new Set();

  const [subs, memberships] = await Promise.all([
    studioSupabase.from("kenko_subscriptions").select("contact_email").eq("subscription_status", "Active"),
    studioSupabase
      .from("kenko_memberships")
      .select("contact_email")
      .eq("membership_status", "Active")
      .in("membership_type", ACTIVE_MEMBERSHIP_TYPES),
  ]);

  if (subs.error) {
    throw new Error(`Studio Supabase active-subscriptions query failed: ${subs.error.message}`);
  }
  if (memberships.error) {
    throw new Error(`Studio Supabase active-memberships query failed: ${memberships.error.message}`);
  }

  const emails = new Set<string>();
  for (const row of subs.data ?? []) {
    if (row.contact_email) emails.add(row.contact_email.toLowerCase());
  }
  for (const row of memberships.data ?? []) {
    if (row.contact_email) emails.add(row.contact_email.toLowerCase());
  }
  return emails;
}

export interface Birthday {
  name: string;
  email: string;
  dateOfBirth: string; // YYYY-MM-DD, the original DOB (year may be old)
  daysUntil: number; // 0 = today, 1 = tomorrow, ... 7 = a week away
}

interface KenkoCustomerRow {
  contact_name: string | null;
  contact_email: string;
  date_of_birth: string | null;
}

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
export async function fetchUpcomingBirthdays(
  from: Date,
  daysAhead: number,
): Promise<Birthday[]> {
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

  const allRows = (data ?? []) as KenkoCustomerRow[];
  const activeEmails = await fetchActiveContactEmails();
  const rows = allRows.filter((r) => activeEmails.has(r.contact_email.toLowerCase()));
  log.debug("birthdays.rows_fetched", { total: allRows.length, active: rows.length });

  return filterUpcomingBirthdays(rows, from, daysAhead);
}

/**
 * Pure filter — exported for unit tests.
 *
 * Builds a Set of "MM-DD" strings for the next `daysAhead` days starting
 * at `from` (inclusive). Matches each customer's DOB MM-DD against the
 * set. Annotates each match with `daysUntil`.
 */
export function filterUpcomingBirthdays(
  rows: KenkoCustomerRow[],
  from: Date,
  daysAhead: number,
): Birthday[] {
  const pad = (n: number) => String(n).padStart(2, "0");
  const monthDay = (d: Date) => `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

  // Build the day map: MM-DD → daysUntil
  const dayMap = new Map<string, number>();
  for (let i = 0; i <= daysAhead; i++) {
    const d = new Date(from);
    d.setDate(d.getDate() + i);
    const key = monthDay(d);
    // First occurrence wins (handles the unlikely case of daysAhead >= 365)
    if (!dayMap.has(key)) dayMap.set(key, i);
  }

  const out: Birthday[] = [];
  for (const row of rows) {
    if (!row.date_of_birth) continue;
    // Expected format from Postgres DATE: "YYYY-MM-DD"
    const match = row.date_of_birth.match(/^\d{4}-(\d{2})-(\d{2})/);
    if (!match) continue;
    const mmdd = `${match[1]}-${match[2]}`;
    const daysUntil = dayMap.get(mmdd);
    if (daysUntil === undefined) continue;
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
