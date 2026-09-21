/**
 * The bot's ONLY door into studio numbers: the curated v_pulse_* views,
 * read as role haven_va over src/lib/studio-db.ts (spec:
 * docs/plans/2026-09-21-pulse-views-spec.md, operating notes:
 * docs/knowledge-base/pulse-views.md). No kenko_* table is readable from
 * here — test/kenko-guard.test.ts keeps it that way.
 *
 * Two rules from the spec that every reader here follows:
 * - "Today" is the DATA date, never the calendar: data-as-of =
 *   max(cycle_starts_at) <= today over v_pulse_membership_state. A renewal
 *   after the last Kenko import is not a churn (Tatyana Khvesko, case #6).
 * - member_id = md5(lower(contact_email)) — no trim — is the join key
 *   every view exposes instead of the email itself.
 *
 * Every date column comes back as "YYYY-MM-DD"; compare as strings.
 */
import { createHash } from "node:crypto";
import { log } from "./log.js";
import { isStudioDbAvailable, query } from "./studio-db.js";
export const PULSE_VIEW = {
    membershipState: "v_pulse_membership_state",
    pauseHistory: "v_pulse_pause_history",
    pausedDetail: "v_pulse_paused_detail",
    introPurchase: "v_pulse_intro_purchase",
    introConversion: "v_pulse_intro_conversion",
    classpackState: "v_pulse_classpack_state",
    introHolderState: "v_pulse_intro_holder_state",
    memberIdentity: "v_pulse_member_identity",
    memberActivity: "v_pulse_member_activity",
    attendanceMonthly: "v_pulse_attendance_monthly",
    utilizationMonthly: "v_pulse_utilization_monthly",
    failedPayments: "v_pulse_failed_payments",
    firstPaid: "v_pulse_first_paid",
    knownCases: "v_pulse_known_cases",
};
export function memberIdFromEmail(email) {
    return createHash("md5").update(email.toLowerCase()).digest("hex");
}
/**
 * Latest cycle start on or before `today` ("YYYY-MM-DD"): the day the data
 * is good through. Null only on an empty view.
 */
export function computeDataAsOf(rows, today) {
    let max = null;
    for (const r of rows) {
        const d = r.cycle_starts_at;
        if (!d || d > today)
            continue;
        if (!max || d > max)
            max = d;
    }
    return max;
}
const CYCLE_GAP_TOLERANCE_DAYS = 3;
function daysBetween(a, b) {
    return (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000;
}
/**
 * Start of the unbroken chain of PAYING cycles that ends in `current`:
 * walk back while the previous paying cycle ends within
 * CYCLE_GAP_TOLERANCE_DAYS of the next one's start. A win-back on the same
 * plan restarts here, where the view's `started` (first start ever for
 * that plan) would not — churn signals must not evaluate months from the
 * gap as "member but never came".
 */
export function continuousSince(cycles, current) {
    const paying = cycles
        .filter((c) => c.is_paying_cycle && c.cycle_starts_at)
        .sort((a, b) => (a.cycle_starts_at < b.cycle_starts_at ? -1 : 1));
    let since = current.cycle_starts_at;
    for (let i = paying.length - 1; i >= 0; i--) {
        const prev = paying[i];
        if (prev.cycle_starts_at >= since)
            continue;
        const prevEnd = prev.cycle_expires_at ?? prev.cycle_billing_ends_at;
        if (!prevEnd || daysBetween(prevEnd, since) > CYCLE_GAP_TOLERANCE_DAYS)
            break;
        since = prev.cycle_starts_at;
    }
    return since;
}
/**
 * The spec's verification query, in code: paying cycles overlapping asOf,
 * one entry per member_id (the latest-starting live cycle wins when a plan
 * change overlaps). 75 on the 2026-09-18 snapshot (test/pulse-views.test.ts).
 */
export function activeMembersAsOf(rows, asOf) {
    const byMember = new Map();
    for (const r of rows) {
        if (!r.cycle_starts_at)
            continue;
        const list = byMember.get(r.member_id) ?? [];
        list.push(r);
        byMember.set(r.member_id, list);
    }
    const out = new Map();
    for (const [memberId, cycles] of byMember) {
        const live = cycles
            .filter((c) => c.is_paying_cycle &&
            c.cycle_starts_at <= asOf &&
            (c.cycle_expires_at === null || c.cycle_expires_at >= asOf))
            .sort((a, b) => (a.cycle_starts_at < b.cycle_starts_at ? 1 : -1));
        const current = live[0];
        if (!current)
            continue;
        out.set(memberId, {
            memberId,
            tier: current.tier ?? "",
            plan: current.plan ?? "",
            membershipName: `${current.tier ?? "?"} Monthly | ${current.plan ?? "?"}`,
            memberSince: continuousSince(cycles, current),
        });
    }
    return out;
}
async function fetchView(view) {
    if (!isStudioDbAvailable()) {
        log.warn("pulse_views.fetch_skipped", { view, reason: "studio_db_not_configured" });
        return [];
    }
    // `view` is one of PULSE_VIEW's literals, never user input — safe to inline.
    return query(`select * from ${view}`);
}
export const fetchMembershipState = () => fetchView(PULSE_VIEW.membershipState);
export const fetchPauseHistory = () => fetchView(PULSE_VIEW.pauseHistory);
export const fetchIntroPurchases = () => fetchView(PULSE_VIEW.introPurchase);
export const fetchIntroConversion = () => fetchView(PULSE_VIEW.introConversion);
export const fetchClasspackState = () => fetchView(PULSE_VIEW.classpackState);
export const fetchIntroHolderState = () => fetchView(PULSE_VIEW.introHolderState);
export const fetchMemberIdentity = () => fetchView(PULSE_VIEW.memberIdentity);
export const fetchMemberActivity = () => fetchView(PULSE_VIEW.memberActivity);
export const fetchUtilizationMonthly = () => fetchView(PULSE_VIEW.utilizationMonthly);
export const fetchFailedPayments = () => fetchView(PULSE_VIEW.failedPayments);
/** Has this person ever paid? (v_pulse_first_paid; absent = a lead.) */
export async function hasEverPaid(memberId) {
    const rows = await query(`select true as ok from ${PULSE_VIEW.firstPaid} where member_id = $1 limit 1`, [memberId]);
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
export function isPulseView(name) {
    return /^v_pulse_[a-z_]+$/.test(name);
}
/** The view's COMMENT (pg_description), or null when it has none. */
export async function getViewComment(view) {
    if (!isPulseView(view))
        throw new Error(`pulse_views: not a v_pulse view: ${view}`);
    const rows = await query(`select obj_description(('va.' || $1)::regclass, 'pg_class') as c`, [view]);
    return rows[0]?.c?.trim() || null;
}
/** Column COMMENTs of a view, in column order, only the columns that have one. */
export async function getColumnComments(view) {
    if (!isPulseView(view))
        throw new Error(`pulse_views: not a v_pulse view: ${view}`);
    return query(`select a.attname as column, col_description(a.attrelid, a.attnum) as comment
       from pg_attribute a
      where a.attrelid = ('va.' || $1)::regclass
        and a.attnum > 0 and not a.attisdropped
        and col_description(a.attrelid, a.attnum) is not null
      order by a.attnum`, [view]);
}
