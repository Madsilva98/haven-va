/**
 * Churn-risk signal computation for src/crons/churn-risk.ts — since
 * 2026-09-21 entirely on the studio's v_pulse_* views (spec:
 * docs/plans/2026-09-21-pulse-views-spec.md). The bot no longer defines
 * "active", "attended", "paused" or "utilization"; it reads them:
 *
 * - Roster: paying cycles in v_pulse_membership_state overlapping the
 *   DATA date (max(cycle_starts_at) <= today), never the calendar — a
 *   renewal after the last import is not a churn (Tatyana Khvesko, case
 *   #6); Cancelation scheduled and pause-scheduled (NULL) are paying
 *   (Andreia taboleiros, case #5); a stale Active row in
 *   kenko_subscriptions is not (Esen Sekerkarar, case #1). Names, emails
 *   and phones come from v_pulse_member_identity on member_id.
 * - Signal 1 "Sem reservas 14+ dias": v_pulse_member_activity's
 *   next_or_last_booked (Booked/Waitlist class days; a future booking is
 *   engagement), measured from the later of the member's continuous
 *   tenure start or the end of their most recent stretched (paused) cycle
 *   in v_pulse_pause_history — Sofia Barata, paused 27/07-27/08, must not
 *   read as "64 dias sem reservar" (2026-09-21).
 * - Signal 2 "Pagamento falhado": v_pulse_failed_payments.failed_45d > 0.
 * - Signal 3 "Baixa utilização": v_pulse_utilization_monthly under 50% in
 *   EACH of the last 3 full calendar months before the data date, skipping
 *   months the view marks had_pause (Raquel Saraiva, Francesca
 *   Buoncristiani, 2026-09-21), months the member had not yet joined for
 *   the whole month, and Unlimited plans (allowance NULL).
 *
 * The thresholds themselves (14 days, 45 days, 50% × 3 months) were
 * empirically validated in session against churned-vs-active members —
 * see the git history of this file for the derivation tables. No staff
 * list lives here: the views exclude staff.
 */

import type { ChurnSignalType } from "../types.js";
import { log } from "./log.js";
import {
  activeMembersAsOf,
  computeDataAsOf,
  fetchFailedPayments,
  fetchMemberActivity,
  fetchMemberIdentity,
  fetchMembershipState,
  fetchPauseHistory,
  fetchUtilizationMonthly,
  type FailedPaymentsRow,
  type MemberActivityRow,
  type PauseHistoryRow,
  type UtilizationMonthRow,
} from "./pulse-views.js";
import { isStudioDbAvailable } from "./studio-db.js";
import { lisbonDateString } from "./tz.js";

const NO_BOOKING_GAP_DAYS = 14;
const UNDERUSE_PCT = 50;
const UNDERUSE_MONTHS = 3;

export interface ActiveSubscriber {
  memberId: string;
  email: string;
  name: string;
  membershipName: string; // "4x Monthly | Premium"
  memberSince: string; // YYYY-MM-DD — start of the unbroken run of paying cycles
}

export interface ChurnInputs {
  asOf: string; // YYYY-MM-DD, the data date
  members: ActiveSubscriber[];
  activityByMember: Map<string, MemberActivityRow>;
  failedByMember: Map<string, FailedPaymentsRow>;
  utilization: UtilizationMonthRow[];
  pauseHistory: Pick<PauseHistoryRow, "member_id" | "cycle_end">[];
}

export interface ChurnFlag {
  email: string;
  name: string;
  plano: string;
  telefone: string | null; // filled in by fetchChurnFlags (I/O); null from computeChurnFlags alone
  signals: { type: ChurnSignalType; detail: string }[];
}

function formatDatePt(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split("-");
  return `${d}/${m}/${y}`;
}

function monthLabelPt(monthIso: string): string {
  return new Date(`${monthIso.slice(0, 10)}T12:00:00Z`).toLocaleDateString("pt-PT", {
    timeZone: "Europe/Lisbon",
    month: "short",
  });
}

function daysBetween(a: string, b: string): number {
  return (Date.parse(`${b.slice(0, 10)}T00:00:00Z`) - Date.parse(`${a.slice(0, 10)}T00:00:00Z`)) / 86_400_000;
}

/**
 * First days of the `monthsBack` full calendar months before the month
 * `asOf` falls in, most recent first. asOf 2026-09-18, 3 → [2026-08-01,
 * 2026-07-01, 2026-06-01].
 */
export function fullMonthsBefore(asOf: string, monthsBack: number): string[] {
  const [y, m] = asOf.slice(0, 10).split("-").map(Number) as [number, number];
  const out: string[] = [];
  for (let i = 1; i <= monthsBack; i++) {
    const d = new Date(Date.UTC(y, m - 1 - i, 1));
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

/**
 * Pure — no I/O. Applies the three signals to already-fetched view rows.
 */
export function computeChurnFlags(inputs: ChurnInputs): ChurnFlag[] {
  const { asOf, members, activityByMember, failedByMember, utilization, pauseHistory } = inputs;
  const flags: ChurnFlag[] = [];

  const utilByMember = new Map<string, Map<string, UtilizationMonthRow>>();
  for (const u of utilization) {
    const byMonth = utilByMember.get(u.member_id) ?? new Map<string, UtilizationMonthRow>();
    byMonth.set(u.month.slice(0, 10), u);
    utilByMember.set(u.member_id, byMonth);
  }
  const lastPauseEndByMember = new Map<string, string>();
  for (const p of pauseHistory) {
    const end = p.cycle_end?.slice(0, 10);
    if (!end || end > asOf) continue;
    const prev = lastPauseEndByMember.get(p.member_id);
    if (!prev || end > prev) lastPauseEndByMember.set(p.member_id, end);
  }
  const months = fullMonthsBefore(asOf, UNDERUSE_MONTHS);

  for (const m of members) {
    const signals: ChurnFlag["signals"] = [];

    // Signal 1 — the stretch to judge starts at the later of tenure start
    // and the most recent pause's cycle end; the view's next_or_last_booked
    // is the latest Booked/Waitlist class day, future included.
    const pauseEnd = lastPauseEndByMember.get(m.memberId);
    const stretchStart = pauseEnd && pauseEnd > m.memberSince ? pauseEnd : m.memberSince;
    const resumedFromPause = stretchStart === pauseEnd;
    const tenureDays = daysBetween(stretchStart, asOf);
    if (tenureDays >= NO_BOOKING_GAP_DAYS) {
      const booked = activityByMember.get(m.memberId)?.next_or_last_booked?.slice(0, 10) ?? null;
      const lastInStretch = booked && booked >= stretchStart ? booked : null;
      const gapDays = lastInStretch ? daysBetween(lastInStretch, asOf) : tenureDays;
      if (gapDays > NO_BOOKING_GAP_DAYS) {
        const detail = lastInStretch
          ? `${Math.round(gapDays)} dias sem reservar (última aula marcada: ${formatDatePt(lastInStretch)})`
          : resumedFromPause
            ? `${Math.round(gapDays)} dias sem reservar desde que voltou da pausa (${formatDatePt(stretchStart)})`
            : `${Math.round(gapDays)} dias sem nenhuma reserva desde a inscrição`;
        signals.push({ type: "Sem reservas 14+ dias", detail });
      }
    }

    // Signal 2 — a failed payment in the last 45 days (the view counts them).
    const failed = failedByMember.get(m.memberId);
    if (failed && failed.failed_45d > 0 && failed.last_failed_on) {
      signals.push({ type: "Pagamento falhado", detail: `pagamento falhado a ${formatDatePt(failed.last_failed_on)}` });
    }

    // Signal 3 — under 50% in each of the last 3 full months, all three
    // present and clean (no pause overlap, joined before the month began,
    // plan with an allowance).
    const byMonth = utilByMember.get(m.memberId);
    if (byMonth) {
      const stats = months.map((month) => {
        const u = byMonth.get(month);
        if (!u || u.in_progress || u.had_pause || u.allowance === null || u.utilization_pct === null) return null;
        if (m.memberSince > month) return null; // not a member for the whole month
        return { month, pct: u.utilization_pct };
      });
      if (stats.every((s) => s !== null) && stats.every((s) => s!.pct < UNDERUSE_PCT)) {
        const parts = stats
          .map((s) => s!)
          .reverse()
          .map((s) => `${monthLabelPt(s.month)}: ${Math.round(s.pct)}%`);
        const avgPct = Math.round(stats.reduce((sum, s) => sum + s!.pct, 0) / stats.length);
        signals.push({
          type: "Baixa utilização",
          detail: `${avgPct}% de utilização média nos últimos ${UNDERUSE_MONTHS} meses (${parts.join(", ")})`,
        });
      }
    }

    if (signals.length > 0) {
      flags.push({ email: m.email, name: m.name, plano: m.membershipName, telefone: null, signals });
    }
  }

  return flags;
}

/**
 * Reads the views and computes flags. Also returns every email currently
 * a paying member (flagged or not) — src/crons/churn-risk.ts uses this to
 * tell "still active, just no current signal" apart from "no longer a
 * member" — and the data date the digest should quote.
 *
 * Returns empty (and logs a warn) if the studio connection isn't
 * configured — same graceful no-op as src/lib/birthdays.ts.
 */
export async function fetchChurnFlags(
  now: Date = new Date(),
): Promise<{ flags: ChurnFlag[]; activeEmails: Set<string>; asOf: string | null }> {
  if (!isStudioDbAvailable()) {
    log.warn("churn_signals.fetch_skipped", { reason: "studio_db_not_configured" });
    return { flags: [], activeEmails: new Set(), asOf: null };
  }

  const [stateRows, pauseHistory, activityRows, failedRows, utilization, identity] = await Promise.all([
    fetchMembershipState(),
    fetchPauseHistory(),
    fetchMemberActivity(),
    fetchFailedPayments(),
    fetchUtilizationMonthly(),
    fetchMemberIdentity(),
  ]);

  const asOf = computeDataAsOf(stateRows, lisbonDateString(now));
  if (!asOf) {
    log.warn("churn_signals.no_data_as_of", { rows: stateRows.length });
    return { flags: [], activeEmails: new Set(), asOf: null };
  }
  const active = activeMembersAsOf(stateRows, asOf);

  const identityByMember = new Map(identity.map((r) => [r.member_id, r]));
  const members: ActiveSubscriber[] = [];
  for (const a of active.values()) {
    const id = identityByMember.get(a.memberId);
    if (!id?.contact_email) {
      log.warn("churn_signals.member_without_identity", { memberId: a.memberId });
      continue;
    }
    members.push({
      memberId: a.memberId,
      email: id.contact_email.toLowerCase(),
      name: id.contact_name?.trim() || id.contact_email,
      membershipName: a.membershipName,
      memberSince: a.memberSince,
    });
  }

  const flags = computeChurnFlags({
    asOf,
    members,
    activityByMember: new Map(activityRows.map((r) => [r.member_id, r])),
    failedByMember: new Map(failedRows.map((r) => [r.member_id, r])),
    utilization,
    pauseHistory,
  });
  for (const flag of flags) {
    const id = identityByMember.get(members.find((m) => m.email === flag.email)!.memberId);
    flag.telefone = id?.contact_phone ?? null;
  }

  log.debug("churn_signals.computed", { asOf, members: members.length, flagged: flags.length });
  return { flags, activeEmails: new Set(members.map((m) => m.email)), asOf };
}
