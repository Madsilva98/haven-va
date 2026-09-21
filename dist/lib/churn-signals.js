/**
 * Churn-risk signal computation for src/crons/churn-risk.ts — since
 * 2026-09-21 entirely on the studio's v_pulse_* views (spec:
 * docs/plans/2026-09-21-pulse-views-spec.md). The bot no longer defines
 * "active", "attended", "paused" or "utilization"; it reads them:
 *
 * - Roster: paying cycles in v_pulse_membership_state overlapping the
 *   DATA date (v_pulse_data_as_of), never the calendar — a renewal after
 *   the last import is not a churn (Tatyana Khvesko, case #6); Cancelation
 *   scheduled and pause-scheduled (NULL) are paying (Andreia taboleiros,
 *   case #5); a stale Active row in kenko_subscriptions is not (Esen
 *   Sekerkarar, case #1). Tenure (member_since) from v_pulse_member_tenure;
 *   names, emails and phones from v_pulse_member_identity on member_id.
 * - Signal 1 "Sem reservas 14+ dias": v_pulse_member_activity's
 *   next_or_last_booked (Booked/Waitlist class days; a future booking is
 *   engagement), measured from the later of member_since or the end of
 *   the member's most recent stretched (paused) cycle in
 *   v_pulse_pause_history — Sofia Barata, paused 27/07-27/08, must not
 *   read as "64 dias sem reservar" (2026-09-21). That cycle_end is the
 *   next charge, not the return date (case #2): the person was back by
 *   then at the latest, so the detail says "de volta até dd/mm". A member
 *   whose pause is_current is skipped outright.
 * - Signal 2 "Pagamento falhado": v_pulse_failed_payments.failed_45d > 0.
 * - Signal 3 "Baixa utilização": v_pulse_utilization_monthly under 50% in
 *   EACH of the last 3 full calendar months before the data date, reading
 *   only is_full_month rows (case #23) without had_pause (Raquel Saraiva,
 *   Francesca Buoncristiani, 2026-09-21), and never Unlimited (allowance
 *   NULL).
 *
 * The thresholds themselves (14 days, 45 days, 50% × 3 months) were
 * empirically validated in session against churned-vs-active members —
 * see the git history of this file for the derivation tables. No staff
 * list lives here: the views exclude staff.
 */
import { log } from "./log.js";
import { activeMembersAsOf, fetchDataAsOf, fetchFailedPayments, fetchMemberActivity, fetchMemberIdentity, fetchMembershipState, fetchMemberTenure, fetchPauseHistory, fetchUtilizationMonthly, } from "./pulse-views.js";
import { isStudioDbAvailable } from "./studio-db.js";
const NO_BOOKING_GAP_DAYS = 14;
const UNDERUSE_PCT = 50;
const UNDERUSE_MONTHS = 3;
function formatDatePt(iso) {
    const [y, m, d] = iso.slice(0, 10).split("-");
    return `${d}/${m}/${y}`;
}
function monthLabelPt(monthIso) {
    return new Date(`${monthIso.slice(0, 10)}T12:00:00Z`).toLocaleDateString("pt-PT", {
        timeZone: "Europe/Lisbon",
        month: "short",
    });
}
function daysBetween(a, b) {
    return (Date.parse(`${b.slice(0, 10)}T00:00:00Z`) - Date.parse(`${a.slice(0, 10)}T00:00:00Z`)) / 86_400_000;
}
/**
 * First days of the `monthsBack` full calendar months before the month
 * `asOf` falls in, most recent first. asOf 2026-09-18, 3 → [2026-08-01,
 * 2026-07-01, 2026-06-01].
 */
export function fullMonthsBefore(asOf, monthsBack) {
    const [y, m] = asOf.slice(0, 10).split("-").map(Number);
    const out = [];
    for (let i = 1; i <= monthsBack; i++) {
        const d = new Date(Date.UTC(y, m - 1 - i, 1));
        out.push(d.toISOString().slice(0, 10));
    }
    return out;
}
/**
 * Pure — no I/O. Applies the three signals to already-fetched view rows.
 */
export function computeChurnFlags(inputs) {
    const { asOf, members, activityByMember, failedByMember, utilization, pauseHistory } = inputs;
    const flags = [];
    const utilByMember = new Map();
    for (const u of utilization) {
        const byMonth = utilByMember.get(u.member_id) ?? new Map();
        byMonth.set(u.month.slice(0, 10), u);
        utilByMember.set(u.member_id, byMonth);
    }
    const lastPauseEndByMember = new Map();
    const pausedNow = new Set();
    for (const p of pauseHistory) {
        if (p.is_current)
            pausedNow.add(p.member_id);
        const end = p.cycle_end?.slice(0, 10);
        if (!end || end > asOf)
            continue;
        const prev = lastPauseEndByMember.get(p.member_id);
        if (!prev || end > prev)
            lastPauseEndByMember.set(p.member_id, end);
    }
    const months = fullMonthsBefore(asOf, UNDERUSE_MONTHS);
    for (const m of members) {
        const signals = [];
        // Signal 1 — the stretch to judge starts at the later of member_since
        // and the most recent past pause's cycle_end (the next charge: they were
        // back by then at the latest, the exact return date is not in the
        // export — case #2). A pause that reads Paused right now is skipped:
        // nothing to judge yet. The view's next_or_last_booked is the latest
        // Booked/Waitlist class day, future included.
        if (!pausedNow.has(m.memberId)) {
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
                            ? `${Math.round(gapDays)} dias sem reservar desde a pausa (de volta até ${formatDatePt(stretchStart)})`
                            : `${Math.round(gapDays)} dias sem nenhuma reserva desde a inscrição`;
                    signals.push({ type: "Sem reservas 14+ dias", detail });
                }
            }
        }
        // Signal 2 — a failed payment in the last 45 days (the view counts them).
        const failed = failedByMember.get(m.memberId);
        if (failed && failed.failed_45d > 0 && failed.last_failed_on) {
            signals.push({ type: "Pagamento falhado", detail: `pagamento falhado a ${formatDatePt(failed.last_failed_on)}` });
        }
        // Signal 3 — under 50% in each of the last 3 full months, all three
        // present and clean: is_full_month (the view's word on "member for the
        // whole month"), no pause overlap, plan with an allowance.
        const byMonth = utilByMember.get(m.memberId);
        if (byMonth) {
            const stats = months.map((month) => {
                const u = byMonth.get(month);
                if (!u || !u.is_full_month || u.had_pause || u.allowance === null || u.utilization_pct === null)
                    return null;
                // Number(): utilization_pct is NUMERIC, which a Postgres driver may
                // hand over as a string. src/lib/studio-db.ts registers a parser so
                // it arrives as a number, but the average below silently prints
                // nonsense (0 + "25" + "0" + "0" = "02500" / 3 = 833%) if that ever
                // stops being true — caught against real rows, 2026-09-21.
                return { month, pct: Number(u.utilization_pct) };
            });
            if (stats.every((s) => s !== null) && stats.every((s) => s.pct < UNDERUSE_PCT)) {
                const parts = stats
                    .map((s) => s)
                    .reverse()
                    .map((s) => `${monthLabelPt(s.month)}: ${Math.round(s.pct)}%`);
                const avgPct = Math.round(stats.reduce((sum, s) => sum + s.pct, 0) / stats.length);
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
export async function fetchChurnFlags() {
    if (!isStudioDbAvailable()) {
        log.warn("churn_signals.fetch_skipped", { reason: "studio_db_not_configured" });
        return { flags: [], activeEmails: new Set(), asOf: null };
    }
    const [asOf, stateRows, tenureRows, pauseHistory, activityRows, failedRows, utilization, identity] = await Promise.all([
        fetchDataAsOf(),
        fetchMembershipState(),
        fetchMemberTenure(),
        fetchPauseHistory(),
        fetchMemberActivity(),
        fetchFailedPayments(),
        fetchUtilizationMonthly(),
        fetchMemberIdentity(),
    ]);
    if (!asOf) {
        log.warn("churn_signals.no_data_as_of", { rows: stateRows.length });
        return { flags: [], activeEmails: new Set(), asOf: null };
    }
    const active = activeMembersAsOf(stateRows, asOf, new Map(tenureRows.map((t) => [t.member_id, t])));
    const identityByMember = new Map(identity.map((r) => [r.member_id, r]));
    const members = [];
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
        const id = identityByMember.get(members.find((m) => m.email === flag.email).memberId);
        flag.telefone = id?.contact_phone ?? null;
    }
    log.debug("churn_signals.computed", { asOf, members: members.length, flagged: flags.length });
    return { flags, activeEmails: new Set(members.map((m) => m.email)), asOf };
}
