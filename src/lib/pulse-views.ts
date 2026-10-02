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
  introClassVisits: "v_pulse_intro_class_visits",
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
  // The bot's three lists (2026-09-30). Their rules live in haven-studio's canonical views
  // (public.v_pulse_intro_outcome, public.v_pulse_churn_risk); these va names are column copies
  // (haven-studio packages/dashboard/supabase/va-schema-and-role-migration.sql, section 2d).
  introPackWatch: "v_pulse_intro_pack_watch",
  introPackLeads: "v_pulse_intro_pack_leads",
  churnRiskSignals: "v_pulse_churn_risk_signals",
  // The bot's own analysis view (reads only va copies, data-model check C6), 2026-10-02:
  // scripts/studio-db-intro-pack-tracking-2026-10-02.sql — the "Tracking intro packs" rules.
  introPackTracking: "v_pulse_intro_pack_tracking",
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
  is_activated: boolean | null; // true = the pack ran (Kenko set an expiry); false = bought, never activated — intro_end is modeled and NOT an expiry (case #25); NULL = no ledger row matched
  kenko_status: string | null; // membership_status of the matched ledger row
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
  currentCycleStartsAt: string; // start of the CURRENT live paying cycle — a later payment can supersede an earlier failure without resetting memberSince
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
      currentCycleStartsAt: current.cycle_starts_at!,
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
 * v_pulse_intro_pack_watch: one row per intro buyer, a column copy of haven-studio's canonical
 * v_pulse_intro_outcome (2026-09-30: the rule lives there, data-model C6) — returns every 2-Class/
 * 10-Day/other intro buyer, not just the ones worth a nudge. `nudge_window` is a leftover flag from
 * the ORIGINAL 2-bucket rule (2-Class 1-of-2-used -> this_week, 10-Day >5-used -> next_3_days) and is
 * deliberately NOT used below — the founder revised the rule the same day (still 2026-09-30) to 4
 * buckets, one of which (10-Day "ending") explicitly drops the old >5-visits requirement, so trusting
 * `nudge_window` would silently keep excluding people it shouldn't anymore. Every bucket is computed
 * fresh here instead, straight off `pack`/`visits_in_pack`/`intro_end`, on the database's own
 * CURRENT_DATE (never `v_pulse_data_as_of` — see the crons/intro-pack-expiring.ts row in CLAUDE.md for
 * why a forward-looking window can't anchor on a lagging data date).
 *
 * first_pack_visit/last_pack_visit (the real first/last check-in date on THIS SPECIFIC pack — not
 * v_pulse_intro_purchase.kenko_start, which is ~= the Kenko ledger start close to the purchase date,
 * and not v_pulse_member_activity.first_visit, which is a LIFETIME first-ever visit that can predate
 * this pack entirely) come from a join against v_pulse_intro_class_visits (per-visit rows, on_pack
 * flag), keyed on (member_id, pack, intro_end) since this view doesn't expose the purchase date to
 * join on directly. Verified against live data before writing this.
 *
 * Four buckets via `reason`, founder's own words (2026-09-30, same day as the original rule):
 * - unused_ending: 2-Class, 1 of 2 used, <=5 days left (a rolling window now, not "this calendar
 *   week" — daily cron, so rolling is simpler and doesn't miss someone with under 5 days left later
 *   in the week), AND no upcoming class already booked (checked against v_pulse_member_activity).
 * - completed_followup (NEW): 2-Class, both used, within 3 days of the 2nd class — for a conversion
 *   follow-up call, not a "come back" reminder ("não estamos a apanhar as pessoas... e fizeram as
 *   duas aulas. quero apanhar estes perto de fazerem a 2ª aula, para fazer follow up"). The 3-day
 *   visibility window is Claude Code's own default — the founder specified when it starts showing,
 *   not how long it keeps showing.
 * - ending: 10-Day, <=5 days left, usage doesn't matter any more ("não interessa quantas aulas fez").
 * - underused (NEW): 10-Day, EXACTLY 5 days since the first check-in on this pack, still at only 1-2
 *   classes — the exact-day match (not >=) is what makes it fire once per person on a daily cron.
 */
export interface IntroPackWatchRow {
  member_id: string;
  email: string;
  pack: string;
  item_name: string;
  intro_end: string;
  visits_in_pack: number;
  nudge_window: "this_week" | "next_3_days" | null;
  first_pack_visit: string | null;
  last_pack_visit: string | null;
  reason: "unused_ending" | "completed_followup" | "ending" | "underused" | null;
}
export async function fetchIntroPackWatch(): Promise<IntroPackWatchRow[]> {
  if (!isStudioDbAvailable()) {
    log.warn("pulse_views.fetch_skipped", { view: PULSE_VIEW.introPackWatch, reason: "studio_db_not_configured" });
    return [];
  }
  return query<IntroPackWatchRow>(
    `with pack_visit_dates as (
       select member_id, ended_on, pack_group, min(day) as first_pack_visit, max(day) as last_pack_visit
       from ${PULSE_VIEW.introClassVisits}
       where on_pack
       group by member_id, ended_on, pack_group
     )
     select
       w.*,
       v.first_pack_visit,
       v.last_pack_visit,
       case
         when w.pack = '2-Class' and w.visits_in_pack = 1 then 'unused_ending'
         when w.pack = '2-Class' and w.visits_in_pack = 2 then 'completed_followup'
         when w.pack = '10-Day' and w.intro_end between current_date and current_date + 5 then 'ending'
         when w.pack = '10-Day' then 'underused'
       end as reason
     from ${PULSE_VIEW.introPackWatch} w
     left join pack_visit_dates v
       on v.member_id = w.member_id and v.ended_on = w.intro_end and v.pack_group = w.pack
     where w.pack in ('2-Class', '10-Day')
       and (
         (w.pack = '2-Class' and w.visits_in_pack = 1
            and w.intro_end between current_date and current_date + 5
            and not exists (
              select 1 from ${PULSE_VIEW.memberActivity} ma
              where ma.member_id = w.member_id and ma.next_or_last_booked >= current_date
            ))
         or (w.pack = '2-Class' and w.visits_in_pack = 2
            and v.last_pack_visit is not null and current_date - v.last_pack_visit between 0 and 3)
         or (w.pack = '10-Day' and w.intro_end between current_date and current_date + 5)
         or (w.pack = '10-Day' and w.visits_in_pack in (1, 2)
            and v.first_pack_visit is not null and current_date - v.first_pack_visit = 5)
       )`,
  );
}

/**
 * v_pulse_intro_pack_leads: one row per intro buyer, a column copy of haven-studio's
 * public.v_pulse_intro_outcome (2026-09-30). is_lead = tracked 2-Class/10-Day intro, no membership or
 * class pack since, ended 21+ days before the last data day; only those rows are read.
 */
export interface IntroPackLeadRow {
  member_id: string;
  email: string;
  pack: string;
  item_name: string;
  intro_end: string;
  visits_in_pack: number;
  days_since_expiry: number;
  is_recent: boolean;
  post_expiry_last_visit: string | null;
  lifetime_visit_count: number;
  is_lead: boolean;
}
export async function fetchIntroPackLeads(): Promise<IntroPackLeadRow[]> {
  if (!isStudioDbAvailable()) {
    log.warn("pulse_views.fetch_skipped", { view: PULSE_VIEW.introPackLeads, reason: "studio_db_not_configured" });
    return [];
  }
  return query<IntroPackLeadRow>(`select * from ${PULSE_VIEW.introPackLeads} where is_lead`);
}

/**
 * v_pulse_intro_pack_tracking: one row per 2-Class/10-Day intro buyer. The view decides everything —
 * `reason` (why they belong on the "Tracking intro packs" list today) and `auto_state` (the state the bot
 * sets on its own); src/crons/intro-pack-tracking.ts only writes it into Notion. Rules and their dates:
 * the view's own SQL file, scripts/studio-db-intro-pack-tracking-2026-10-02.sql.
 */
export type IntroTrackingReason = "waiting_to_start" | "underused" | "pack_ending" | "pack_ended";
export type IntroTrackingAutoState = "converted" | "bought_other" | "cold_lead" | "idle";
export interface IntroPackTrackingRow {
  member_id: string;
  email: string;
  item_name: string;
  pack: "2-Class" | "10-Day";
  bought_on: string;
  first_class_on: string | null;
  expires_on: string;
  ended_on: string;
  visits_in_pack: number;
  booked_ahead: number;
  outcome: string;
  data_as_of: string;
  auto_state: IntroTrackingAutoState | null;
  is_lead: boolean; // 21+ days since the same end, not converted — the Monday "Leads a contactar" rule
  days_since_end: number;
  is_recent: boolean; // under 28 days since the end: crossed day 21 within about the last week
  reason: IntroTrackingReason | null;
}
export const fetchIntroPackTracking = (): Promise<IntroPackTrackingRow[]> =>
  fetchView<IntroPackTrackingRow>(PULSE_VIEW.introPackTracking);
export async function fetchIntroPackTrackingLeads(): Promise<IntroPackTrackingRow[]> {
  if (!isStudioDbAvailable()) {
    log.warn("pulse_views.fetch_skipped", { view: PULSE_VIEW.introPackTracking, reason: "studio_db_not_configured" });
    return [];
  }
  return query<IntroPackTrackingRow>(`select * from ${PULSE_VIEW.introPackTracking} where is_lead`);
}

/**
 * v_pulse_churn_risk_signals: one row per active member, a column copy of haven-studio's
 * public.v_pulse_churn_risk (2026-09-30), the same rules the dashboard's Members page shows.
 */
export interface ChurnRiskSignalRow {
  member_id: string;
  current_tier: string | null;
  current_plan: string | null;
  has_no_booking: boolean;
  no_booking_gap_days: number | null;
  no_booking_last_date: string | null;
  no_booking_stretch_start: string | null;
  no_booking_resumed_from_pause: boolean | null;
  has_failed_payment: boolean;
  failed_payment_date: string | null;
  has_low_utilization: boolean;
  low_util_avg_pct: number | null;
  low_util_months: { month: string; pct: number }[] | null;
}
export const fetchChurnRiskSignals = (): Promise<ChurnRiskSignalRow[]> =>
  fetchView<ChurnRiskSignalRow>(PULSE_VIEW.churnRiskSignals);

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
