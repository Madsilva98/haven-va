/**
 * The bot's ONLY door into studio numbers: the curated v_pulse_* views,
 * read as role haven_va over src/lib/studio-db.ts (spec:
 * docs/plans/2026-09-21-pulse-views-spec.md, operating notes:
 * docs/knowledge-base/pulse-views.md). No kenko_* table is readable from
 * here — test/kenko-guard.test.ts keeps it that way.
 *
 * Two rules from the spec that every reader here follows:
 * - "Today" is the DATA date, never the calendar: v_pulse_data_as_of, one
 *   row, the same anchor Studio Pulse uses (fetchDataAsOf). A renewal
 *   after the last Kenko import is not a churn (Tatyana Khvesko, case #6).
 * - member_id = md5(lower(contact_email)) — no trim — is the join key
 *   every view exposes instead of the email itself.
 *
 * Nothing is derived here that a view can state: tenure comes from
 * v_pulse_member_tenure, full months from v_pulse_utilization_monthly,
 * pack use from v_pulse_intro_purchase. A question no view answers is a
 * pulse_cases row, not a helper in this file.
 *
 * Every date column comes back as "YYYY-MM-DD"; compare as strings.
 */

import { createHash } from "node:crypto";

import { log } from "./log.js";
import type { QueryResultRow } from "pg";

import { isStudioDbAvailable, query } from "./studio-db.js";

export const PULSE_VIEW = {
  membershipState: "v_pulse_membership_state",
  pauseHistory: "v_pulse_pause_history",
  pausedDetail: "v_pulse_paused_detail",
  introPurchase: "v_pulse_intro_purchase",
  introConversion: "v_pulse_intro_conversion",
  classpackState: "v_pulse_classpack_state",
  introHolderState: "v_pulse_intro_holder_state",
  dataAsOf: "v_pulse_data_as_of",
  memberTenure: "v_pulse_member_tenure",
  memberIdentity: "v_pulse_member_identity",
  memberActivity: "v_pulse_member_activity",
  attendanceMonthly: "v_pulse_attendance_monthly",
  utilizationMonthly: "v_pulse_utilization_monthly",
  failedPayments: "v_pulse_failed_payments",
  firstPaid: "v_pulse_first_paid",
  knownCases: "v_pulse_known_cases",
} as const;

export type PulseViewName = (typeof PULSE_VIEW)[keyof typeof PULSE_VIEW];

export function memberIdFromEmail(email: string): string {
  return createHash("md5").update(email.toLowerCase()).digest("hex");
}

/** One row per billing cycle of a recurring subscription. */
export interface MembershipStateRow {
  member_id: string;
  tier: string | null; // "4x" | "8x" | "12x" | "Unlimited"
  plan: string | null; // "Premium" | "Essentials"
  status: string | null; // Kenko's raw membership_status; NULL = pause scheduled = paying
  started: string | null; // first start ever for this plan (a same-plan win-back keeps the old date)
  cycle_starts_at: string | null;
  cycle_expires_at: string | null; // clamped to churned_on on a Canceled cycle
  cycle_billing_ends_at: string | null;
  is_paying_cycle: boolean; // Active / Upcoming / Expired / Cancelation scheduled / NULL / Canceled-with-churn-date
  is_paused: boolean;
  is_unpaid: boolean;
  churned_on: string | null;
  owes_dues: boolean;
}

/** One row per billing cycle stretched by a pause (status Paused, or pause_days_est >= 7). */
export interface PauseHistoryRow {
  member_id: string;
  contact_name: string | null;
  contact_email: string | null;
  membership_name: string | null;
  cycle_start: string;
  cycle_end: string; // when billing resumed/resumes — NOT the pause end
  membership_status: string | null;
  is_current: boolean;
  pause_days_est: number | null;
}

/** One row per intro pack sold; intro_end is Kenko's real expiry when known. */
export interface IntroPurchaseRow {
  sale_id: number;
  email: string;
  member_id: string;
  item_name: string;
  pack: string; // "2-Class" | "10-Day" | "5-Class" | "Open Day" | "Intro other"
  intro_purchase: string;
  kenko_start: string | null; // ledger activation; NULL when unmatched
  intro_end: string;
  intro_end_source: "kenko" | "modeled";
  is_open_day: boolean;
  is_valentine: boolean;
  is_for_members: boolean;
  visits_in_pack: number; // check-ins booked ON this pack between purchase and intro_end — not lifetime visits
}

/** One row per first-time intro buyer. */
export interface IntroConversionRow {
  member_id: string;
  intro_date: string;
  intro_end: string;
  pack: string;
  converted: boolean; // a 4x/8x/12x/Unlimited subscription on or after the purchase (mid-pack counts)
  converted_pack: boolean; // no membership, but a real 5x/10x pack — never chase as a lead
  pack_type: string | null;
  tier: string | null;
  days_to_convert: number | null;
}

/** v_pulse_classpack_state (has_credits) and v_pulse_intro_holder_state (no has_credits). */
export interface PackWindowRow {
  member_id: string;
  started: string | null;
  expires: string | null;
  has_credits?: boolean;
}

/** PII — join only when a human needs the name. Staff/test excluded. */
export interface MemberIdentityRow {
  member_id: string;
  contact_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  date_of_birth: string | null;
}

/** One row per person who ever booked or visited. A visit = checkin_status
 * Yes alone (a checked-in-then-cancelled class counts). last_booked = latest
 * Booked/Waitlist class day up to today; next_or_last_booked includes future
 * bookings. Idle signals read the booked columns; "did they come back" reads
 * last_visit. */
export interface MemberActivityRow {
  member_id: string;
  first_visit: string | null;
  last_visit: string | null;
  visit_count: number;
  last_booked: string | null;
  next_or_last_booked: string | null;
}

/** Attended vs plan allowance per member per calendar month, for months
 * with a paying cycle. Skip had_pause and in_progress months; allowance
 * NULL = Unlimited. ±1 class of noise: never one month as a verdict. */
export interface UtilizationMonthRow {
  member_id: string;
  month: string; // first day of the month
  tier: string | null;
  allowance: number | null;
  attended: number;
  utilization_pct: number | null;
  had_pause: boolean;
  in_progress: boolean;
  is_full_month: boolean; // a paying cycle covered the 1st and the last day, and the month is over — the only rows a utilization signal reads
}

/** One row per person who ever had a paying cycle. member_since = start of
 * the LATEST continuous run (a gap of up to 3 days is the same run);
 * run_ends NULL = still open. */
export interface MemberTenureRow {
  member_id: string;
  first_start: string;
  member_since: string;
  run_ends: string | null;
  continuous_days: number;
  cycles_in_run: number;
  runs_total: number;
}

/** One row per member with at least one Failed payment; failed_45d counts
 * from calendar today (a stale import under-counts, never over-counts). */
export interface FailedPaymentsRow {
  member_id: string;
  failed_45d: number;
  failed_ever: number;
  last_failed_on: string | null;
  last_failed_amount: number | null;
}

/** One row per person who ever paid; absent = a lead. */
export interface FirstPaidRow {
  member_id: string;
  first_paid_on: string;
  last_paid_on: string;
  paid_total: number;
}

export interface ActiveMember {
  memberId: string;
  tier: string;
  plan: string;
  membershipName: string; // "4x Monthly | Premium" — the label existing Notion rows carry
  memberSince: string; // v_pulse_member_tenure.member_since — start of the latest continuous run
}

/**
 * The spec's verification query, in code: paying cycles overlapping asOf,
 * one entry per member_id (the latest-starting live cycle wins when a plan
 * change overlaps). 75 on the 2026-09-18 snapshot (test/pulse-views.test.ts).
 * `tenure` supplies memberSince; a member missing from it (should not
 * happen — every paying cycle is a run) falls back to the live cycle start.
 */
export function activeMembersAsOf(
  rows: MembershipStateRow[],
  asOf: string,
  tenure: Map<string, MemberTenureRow> = new Map(),
): Map<string, ActiveMember> {
  const byMember = new Map<string, MembershipStateRow[]>();
  for (const r of rows) {
    if (!r.cycle_starts_at) continue;
    const list = byMember.get(r.member_id) ?? [];
    list.push(r);
    byMember.set(r.member_id, list);
  }
  const out = new Map<string, ActiveMember>();
  for (const [memberId, cycles] of byMember) {
    const live = cycles
      .filter(
        (c) =>
          c.is_paying_cycle &&
          c.cycle_starts_at! <= asOf &&
          (c.cycle_expires_at === null || c.cycle_expires_at >= asOf),
      )
      .sort((a, b) => (a.cycle_starts_at! < b.cycle_starts_at! ? 1 : -1));
    const current = live[0];
    if (!current) continue;
    out.set(memberId, {
      memberId,
      tier: current.tier ?? "",
      plan: current.plan ?? "",
      membershipName: `${current.tier ?? "?"} Monthly | ${current.plan ?? "?"}`,
      memberSince: tenure.get(memberId)?.member_since ?? current.cycle_starts_at!,
    });
  }
  return out;
}

async function fetchView<T extends QueryResultRow>(view: PulseViewName): Promise<T[]> {
  if (!isStudioDbAvailable()) {
    log.warn("pulse_views.fetch_skipped", { view, reason: "studio_db_not_configured" });
    return [];
  }
  // `view` is one of PULSE_VIEW's literals, never user input — safe to inline.
  return query<T>(`select * from ${view}`);
}

export const fetchMembershipState = (): Promise<MembershipStateRow[]> =>
  fetchView<MembershipStateRow>(PULSE_VIEW.membershipState);
export const fetchPauseHistory = (): Promise<PauseHistoryRow[]> =>
  fetchView<PauseHistoryRow>(PULSE_VIEW.pauseHistory);
export const fetchIntroPurchases = (): Promise<IntroPurchaseRow[]> =>
  fetchView<IntroPurchaseRow>(PULSE_VIEW.introPurchase);
export const fetchIntroConversion = (): Promise<IntroConversionRow[]> =>
  fetchView<IntroConversionRow>(PULSE_VIEW.introConversion);
export const fetchClasspackState = (): Promise<PackWindowRow[]> =>
  fetchView<PackWindowRow>(PULSE_VIEW.classpackState);
export const fetchIntroHolderState = (): Promise<PackWindowRow[]> =>
  fetchView<PackWindowRow>(PULSE_VIEW.introHolderState);
export const fetchMemberTenure = (): Promise<MemberTenureRow[]> =>
  fetchView<MemberTenureRow>(PULSE_VIEW.memberTenure);
export const fetchMemberIdentity = (): Promise<MemberIdentityRow[]> =>
  fetchView<MemberIdentityRow>(PULSE_VIEW.memberIdentity);
export const fetchMemberActivity = (): Promise<MemberActivityRow[]> =>
  fetchView<MemberActivityRow>(PULSE_VIEW.memberActivity);
export const fetchUtilizationMonthly = (): Promise<UtilizationMonthRow[]> =>
  fetchView<UtilizationMonthRow>(PULSE_VIEW.utilizationMonthly);
export const fetchFailedPayments = (): Promise<FailedPaymentsRow[]> =>
  fetchView<FailedPaymentsRow>(PULSE_VIEW.failedPayments);

/**
 * The last date the studio data covers — the one "today" for every roster,
 * every signal and every "dados até" line. Null only when the view is
 * empty or the connection is missing.
 */
export async function fetchDataAsOf(): Promise<string | null> {
  if (!isStudioDbAvailable()) {
    log.warn("pulse_views.fetch_skipped", { view: PULSE_VIEW.dataAsOf, reason: "studio_db_not_configured" });
    return null;
  }
  const rows = await query<{ data_as_of: string | null }>(`select data_as_of from ${PULSE_VIEW.dataAsOf}`);
  return rows[0]?.data_as_of ?? null;
}

/** Has this person ever paid? (v_pulse_first_paid; absent = a lead.) */
export async function hasEverPaid(memberId: string): Promise<boolean> {
  const rows = await query<{ ok: boolean }>(
    `select true as ok from ${PULSE_VIEW.firstPaid} where member_id = $1 limit 1`,
    [memberId],
  );
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// View COMMENTs, live, over the bot's own connection: the va.* mirrors carry
// the same COMMENT ON view/column as the public v_pulse_* originals (the
// studio migration copies them), and obj_description / col_description need
// no privilege beyond seeing the object. "porquê?" answers with these.
// ---------------------------------------------------------------------------

/** A v_pulse_* name as the studio spells them. The name is always bound as
 * a parameter below, so this only keeps junk out of the regclass cast. */
export function isPulseView(name: string): boolean {
  return /^v_pulse_[a-z_]+$/.test(name);
}

/** The view's COMMENT (pg_description), or null when it has none. */
export async function getViewComment(view: string): Promise<string | null> {
  if (!isPulseView(view)) throw new Error(`pulse_views: not a v_pulse view: ${view}`);
  const rows = await query<{ c: string | null }>(
    `select obj_description(('va.' || $1)::regclass, 'pg_class') as c`,
    [view],
  );
  return rows[0]?.c?.trim() || null;
}

/** Column COMMENTs of a view, in column order, only the columns that have one. */
export async function getColumnComments(view: string): Promise<{ column: string; comment: string }[]> {
  if (!isPulseView(view)) throw new Error(`pulse_views: not a v_pulse view: ${view}`);
  return query<{ column: string; comment: string }>(
    `select a.attname as column, col_description(a.attrelid, a.attnum) as comment
       from pg_attribute a
      where a.attrelid = ('va.' || $1)::regclass
        and a.attnum > 0 and not a.attisdropped
        and col_description(a.attrelid, a.attnum) is not null
      order by a.attnum`,
    [view],
  );
}
