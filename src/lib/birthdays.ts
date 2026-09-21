/**
 * Customer-birthday lookup against the studio's views
 * (docs/plans/2026-09-21-pulse-views-spec.md). Year-agnostic: matches
 * month+day of date_of_birth against a reference date or range.
 *
 * Who gets a message: a paying member (v_pulse_membership_state, as of the
 * data date), a class-pack holder with credits left
 * (v_pulse_classpack_state) or an intro-pack holder
 * (v_pulse_intro_holder_state) — without that filter the digest would wish
 * happy birthday to leads and churned customers too (confirmed for real,
 * 2026-09-16). Names and dates of birth come from v_pulse_member_identity,
 * the one PII view, joined on member_id = md5(lower(email)); staff and
 * test accounts are already excluded there.
 *
 * Used by the daily birthdays cron — see src/crons/birthdays.ts.
 */

import { log } from "./log.js";
import {
  activeMembersAsOf,
  computeDataAsOf,
  fetchClasspackState,
  fetchIntroHolderState,
  fetchMemberIdentity,
  fetchMembershipState,
  type ActiveMember,
  type PackWindowRow,
} from "./pulse-views.js";
import { isStudioDbAvailable } from "./studio-db.js";
import { lisbonDateString } from "./tz.js";

/**
 * Pure — no I/O. The birthday audience as of the data date: a paying
 * member, a class-pack holder with credits, or an intro-pack holder.
 */
export function activeMemberIdsForBirthdays(
  members: Map<string, ActiveMember>,
  classpacks: PackWindowRow[],
  introHolders: PackWindowRow[],
  asOf: string,
): Set<string> {
  const live = (w: PackWindowRow) => !!w.started && w.started <= asOf && (!w.expires || w.expires >= asOf);
  const ids = new Set(members.keys());
  for (const w of classpacks) if (live(w) && w.has_credits) ids.add(w.member_id);
  for (const w of introHolders) if (live(w)) ids.add(w.member_id);
  return ids;
}

async function fetchActiveMemberIds(now: Date): Promise<Set<string>> {
  const [stateRows, classpacks, introHolders] = await Promise.all([
    fetchMembershipState(),
    fetchClasspackState(),
    fetchIntroHolderState(),
  ]);
  const asOf = computeDataAsOf(stateRows, lisbonDateString(now));
  if (!asOf) return new Set();
  return activeMemberIdsForBirthdays(activeMembersAsOf(stateRows, asOf), classpacks, introHolders, asOf);
}

export interface Birthday {
  name: string;
  email: string;
  dateOfBirth: string; // YYYY-MM-DD, the original DOB (year may be old)
  daysUntil: number; // 0 = today, 1 = tomorrow, ... 7 = a week away
}

interface KenkoCustomerRow {
  member_id?: string;
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
  if (!isStudioDbAvailable()) {
    log.warn("birthdays.fetch_skipped", { reason: "studio_db_not_configured" });
    return [];
  }

  const [identity, activeIds] = await Promise.all([fetchMemberIdentity(), fetchActiveMemberIds(from)]);
  const allRows: KenkoCustomerRow[] = identity
    .filter((r) => r.contact_email && r.date_of_birth)
    .map((r) => ({
      member_id: r.member_id,
      contact_name: r.contact_name,
      contact_email: r.contact_email!,
      date_of_birth: r.date_of_birth,
    }));
  const rows = allRows.filter((r) => r.member_id && activeIds.has(r.member_id));
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
