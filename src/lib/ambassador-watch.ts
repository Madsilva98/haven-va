/**
 * The ambassador programme between two Kenko imports (Madalena, 2026-10-15):
 * who started counting for an ambassador, who scheduled a cancellation, who
 * left, and what that does to the tier at the next count on the 1st. Pure.
 *
 * Who counts is the view's rule (v_pulse_ambassador_referrals: excluded_reason
 * null and active_on_data_as_of); tiers and labels come from
 * v_pulse_ambassador_tier_today / _tier_scale when they exist. The only facts
 * read here are membership statuses (v_pulse_membership_state), to say WHY
 * someone stopped counting and who has a cancellation scheduled.
 */

import { isSuspiciousBatch } from "./circuit-breaker.js";
import type {
  AmbassadorReferralRow,
  AmbassadorTierRow,
  AmbassadorTierScaleRow,
  AmbassadorTierTodayRow,
  MembershipStatusRow,
} from "./pulse-views.js";

export const CANCEL_SCHEDULED = "Cancelation scheduled";

/** One ambassador on one import — what the next import is diffed against. */
export interface AmbassadorSnapshot {
  /** Referred people counting today (the view's rule). */
  counting: string[];
  /** Of `counting`, those with a cancellation scheduled. */
  cancelScheduled: string[];
  /** The ambassador's own membership covers the data date (pause included). */
  selfMember: boolean;
  selfCancelScheduled: boolean;
}
export type Snapshot = Record<string, AmbassadorSnapshot>;

export function buildSnapshot(referrals: AmbassadorReferralRow[], statuses: Map<string, MembershipStatusRow>): Snapshot {
  const snap: Snapshot = {};
  for (const r of referrals) {
    const own = statuses.get(r.ambassador_member_id);
    const a = (snap[r.ambassador_member_id] ??= {
      counting: [],
      cancelScheduled: [],
      selfMember: own?.covers === true,
      selfCancelScheduled: own?.covers === true && own.status === CANCEL_SCHEDULED,
    });
    if (r.excluded_reason !== null || r.active_on_data_as_of !== true) continue;
    a.counting.push(r.referred_member_id);
    const st = statuses.get(r.referred_member_id);
    if (st?.covers && st.status === CANCEL_SCHEDULED) a.cancelScheduled.push(r.referred_member_id);
  }
  for (const a of Object.values(snap)) {
    a.counting.sort();
    a.cancelScheduled.sort();
  }
  return snap;
}

export type LeftReason = "cancelou" | "expirou" | "pausou" | "saiu";

export interface AmbassadorNews {
  ambassadorId: string;
  entered: string[];
  left: { id: string; reason: LeftReason }[];
  /** Newly scheduled since the last import (still counting). */
  cancelScheduled: string[];
  /** The ambassador scheduled their own cancellation since the last import. */
  selfCancelScheduled: boolean;
  /** The ambassador's own membership ended since the last import. */
  selfLeft: boolean;
  /** Counting today. */
  countNow: number;
}

export function leftReason(status: MembershipStatusRow | undefined): LeftReason {
  if (!status) return "saiu";
  if (status.covers) return status.status === "Paused" ? "pausou" : "saiu";
  if (status.status === "Canceled") return "cancelou";
  if (status.status === "Expired") return "expirou";
  return "saiu";
}

function hasStake(now: AmbassadorSnapshot, before: AmbassadorSnapshot | undefined): boolean {
  return now.counting.length > 0 || (before?.counting.length ?? 0) > 0;
}

/**
 * What changed per ambassador between two imports. `prev` null = the first
 * import ever seen: a baseline, no news (otherwise everyone counting would
 * read as "entrou").
 */
export function planAmbassadorNews(
  prev: Snapshot | null,
  now: Snapshot,
  statuses: Map<string, MembershipStatusRow>,
): AmbassadorNews[] {
  if (prev === null) return [];
  const news: AmbassadorNews[] = [];
  for (const [id, a] of Object.entries(now)) {
    const before = prev[id];
    const was = new Set(before?.counting ?? []);
    const is = new Set(a.counting);
    const wasScheduled = new Set(before?.cancelScheduled ?? []);
    const n: AmbassadorNews = {
      ambassadorId: id,
      entered: a.counting.filter((r) => !was.has(r)),
      left: [...was].filter((r) => !is.has(r)).sort().map((r) => ({ id: r, reason: leftReason(statuses.get(r)) })),
      cancelScheduled: a.cancelScheduled.filter((r) => !wasScheduled.has(r)),
      // The ambassador's own membership is news only when they have someone counting (a discount at stake).
      selfCancelScheduled:
        hasStake(a, before) && a.selfCancelScheduled && !(before?.selfCancelScheduled ?? false),
      selfLeft: hasStake(a, before) && !a.selfMember && (before?.selfMember ?? false),
      countNow: a.counting.length,
    };
    if (n.entered.length + n.left.length + n.cancelScheduled.length > 0 || n.selfCancelScheduled || n.selfLeft) {
      news.push(n);
    }
  }
  // An ambassador gone from the view altogether: everyone they had left.
  for (const [id, before] of Object.entries(prev)) {
    if (now[id] || before.counting.length === 0) continue;
    news.push({
      ambassadorId: id,
      entered: [],
      left: before.counting.map((r) => ({ id: r, reason: leftReason(statuses.get(r)) })),
      cancelScheduled: [],
      selfCancelScheduled: false,
      selfLeft: false,
      countNow: 0,
    });
  }
  return news;
}

/** More than half the people counting leaving in one import is a broken import far more often than a real week. */
export function suspiciousImportReason(prev: Snapshot | null, news: AmbassadorNews[]): string | null {
  if (prev === null) return null;
  const before = Object.values(prev).reduce((n, a) => n + a.counting.length, 0);
  const left = news.reduce((n, a) => n + a.left.length, 0);
  if (isSuspiciousBatch(left, before, { share: 0.5, minRows: 4 })) {
    return `${left} das ${before} pessoas referidas deixavam de contar de uma vez.`;
  }
  return null;
}

export interface Tier {
  tier: number;
  /** null = no discount. */
  label: string | null;
}

function asTier(tier: number, label: string): Tier {
  return { tier, label: tier >= 1 ? label : null };
}

/** The tier a count would give, from the scale view. Null without the scale. */
export function tierForCount(scale: AmbassadorTierScaleRow[] | null, count: number, isFirstFive: boolean): Tier | null {
  if (!scale) return null;
  const row = scale.find((s) => count >= s.min_referred && (s.max_referred === null || count <= s.max_referred));
  if (!row) return null;
  return asTier(row.tier, isFirstFive ? row.first_five_label : row.discount_label);
}

/** The tier in force: the latest monthly count for this ambassador (none before the first 1st). */
export function tierInForce(monthly: AmbassadorTierRow[], ambassadorId: string): Tier {
  const latest = monthly
    .filter((r) => r.ambassador_member_id === ambassadorId)
    .sort((a, b) => (a.month_start < b.month_start ? 1 : -1))[0];
  return latest ? asTier(latest.tier, latest.discount_label) : { tier: 0, label: null };
}

export function tierToday(today: AmbassadorTierTodayRow[] | null, ambassadorId: string): Tier | null {
  if (!today) return null;
  const row = today.find((r) => r.ambassador_member_id === ambassadorId);
  return row ? asTier(row.tier, row.discount_label) : { tier: 0, label: null };
}

const MONTHS = [
  "janeiro", "fevereiro", "março", "abril", "maio", "junho",
  "julho", "agosto", "setembro", "outubro", "novembro", "dezembro",
];

/** "2026-11-14" → "1 de dezembro" (the next count after the data date). */
export function nextCountLabel(asOf: string): string {
  const m = Number(asOf.slice(5, 7));
  return `1 de ${MONTHS[m % 12]}`;
}

function show(label: string | null): string {
  return label ?? "sem desconto";
}

/** "Sobe de 15% para 50% na contagem de 1 de dezembro." — null when the tier for today isn't known. */
export function effectOnNextCount(inForce: Tier, today: Tier | null, asOf: string): string | null {
  if (!today) return null;
  const when = `na contagem de ${nextCountLabel(asOf)}`;
  if (today.tier > inForce.tier) {
    return inForce.tier === 0 ? `Passa a ter ${today.label} ${when}.` : `Sobe de ${inForce.label} para ${today.label} ${when}.`;
  }
  if (today.tier < inForce.tier) return `Desce de ${inForce.label} para ${show(today.label)} ${when}.`;
  return today.tier >= 1 ? `Mantém ${today.label}.` : "Ainda sem desconto.";
}

/** "Se sair, mantém 15%." / "Se sair, desce para 10%." — null without the scale. */
export function effectIfScheduledLeave(
  scale: AmbassadorTierScaleRow[] | null,
  today: Tier | null,
  countNow: number,
  scheduled: number,
  isFirstFive: boolean,
): string | null {
  if (!today || scheduled === 0) return null;
  const after = tierForCount(scale, countNow - scheduled, isFirstFive);
  if (!after) return null;
  const who = scheduled === 1 ? "Se sair" : "Se saírem";
  return after.tier < today.tier ? `${who}, desce para ${show(after.label)}.` : `${who}, mantém ${show(today.label)}.`;
}

/** At risk: the tier today is below the one in force, or someone counting (or the ambassador) has a cancellation scheduled. */
export function isAtRisk(snapshot: AmbassadorSnapshot, inForce: Tier, today: Tier | null, inForceCount: number): boolean {
  if (snapshot.cancelScheduled.length > 0 || snapshot.selfCancelScheduled) return true;
  if (today) return today.tier < inForce.tier;
  return snapshot.counting.length < inForceCount;
}
