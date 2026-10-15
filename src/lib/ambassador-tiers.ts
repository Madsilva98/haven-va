/**
 * Who moved tier in the ambassador programme between two monthly counts
 * (v_pulse_ambassador_tier_monthly, one row per ambassador per 1st). Pure:
 * the view says each ambassador's tier and discount label; this only diffs
 * two months. The tier mapping (1 → 10%, 2–3 → 15%, …) and the first-five
 * labels live in the view, never here (Madalena, 2026-10-15).
 */

import { isSuspiciousBatch } from "./circuit-breaker.js";
import type { AmbassadorTierRow } from "./pulse-views.js";

export interface TierChange {
  memberId: string;
  /** Tier on the previous 1st; 0 when they had none (or were not in the view). */
  fromTier: number;
  toTier: number;
  /** Label on the previous 1st; null when they had no discount. */
  fromLabel: string | null;
  /** Label on this 1st; null when the discount stops. */
  toLabel: string | null;
  /** Referred people holding an active membership on this 1st. */
  activeReferred: number;
  /** False when the ambassador themself holds no membership on this 1st: the discount stops. */
  isMember: boolean;
}

export interface AmbassadorTierPlan {
  up: TierChange[];
  down: TierChange[];
  /** First month ever with tier ≥ 1. */
  new: TierChange[];
  /** Had tier ≥ 1, now 0 — fewer referrals, or `isMember` false (flagged separately). */
  left: TierChange[];
}

/**
 * `thisMonth` and `lastMonth` are the rows of two consecutive 1sts; `earlier`
 * is every row before `lastMonth` — someone back at tier ≥ 1 after a month at
 * 0 moved up, they are not new. On the first count ever (`lastMonth` and
 * `earlier` empty) everyone with tier ≥ 1 is new.
 */
export function planAmbassadorTierChanges(
  thisMonth: AmbassadorTierRow[],
  lastMonth: AmbassadorTierRow[],
  earlier: AmbassadorTierRow[] = [],
): AmbassadorTierPlan {
  const before = new Map(lastMonth.map((r) => [r.ambassador_member_id, r]));
  const everTiered = new Set(earlier.filter((r) => r.tier >= 1).map((r) => r.ambassador_member_id));
  const plan: AmbassadorTierPlan = { up: [], down: [], new: [], left: [] };
  const seen = new Set<string>();

  for (const now of thisMonth) {
    seen.add(now.ambassador_member_id);
    const prev = before.get(now.ambassador_member_id);
    const fromTier = prev?.tier ?? 0;
    if (now.tier === fromTier) continue;
    const change: TierChange = {
      memberId: now.ambassador_member_id,
      fromTier,
      toTier: now.tier,
      fromLabel: fromTier >= 1 ? (prev?.discount_label ?? null) : null,
      toLabel: now.tier >= 1 ? now.discount_label : null,
      activeReferred: now.active_referred,
      isMember: now.ambassador_is_member,
    };
    if (now.tier === 0) plan.left.push(change);
    else if (fromTier === 0 && !everTiered.has(now.ambassador_member_id)) plan.new.push(change);
    else if (now.tier > fromTier) plan.up.push(change);
    else plan.down.push(change);
  }

  // Tiered last month and missing from this month's rows altogether: the
  // discount stops all the same.
  for (const prev of lastMonth) {
    if (prev.tier < 1 || seen.has(prev.ambassador_member_id)) continue;
    plan.left.push({
      memberId: prev.ambassador_member_id,
      fromTier: prev.tier,
      toTier: 0,
      fromLabel: prev.discount_label,
      toLabel: null,
      activeReferred: 0,
      isMember: false,
    });
  }
  return plan;
}

export function isEmptyPlan(plan: AmbassadorTierPlan): boolean {
  return plan.up.length + plan.down.length + plan.new.length + plan.left.length === 0;
}

// More than half the tiered ambassadors changing in one month is far more
// likely a late or broken Kenko import than a real month.
const MOVE_BREAKER = { share: 0.5, minRows: 4 };

/**
 * Why this month's count should not be posted, in pt-PT — or null when it
 * looks real. Never trips on the first count (nothing to compare against).
 */
export function suspiciousReason(
  plan: AmbassadorTierPlan,
  thisMonth: AmbassadorTierRow[],
  lastMonth: AmbassadorTierRow[],
): string | null {
  const tieredBefore = lastMonth.filter((r) => r.tier >= 1).length;
  if (tieredBefore === 0) return null;
  const tieredNow = thisMonth.filter((r) => r.tier >= 1).length;
  if (thisMonth.length === 0 || tieredNow === 0) {
    return `a vista veio sem nenhum embaixador com desconto, quando no mês anterior havia ${tieredBefore}.`;
  }
  const ids = new Set(
    [...lastMonth, ...thisMonth].filter((r) => r.tier >= 1).map((r) => r.ambassador_member_id),
  );
  const moved = plan.up.length + plan.down.length + plan.left.length;
  if (isSuspiciousBatch(moved, ids.size, MOVE_BREAKER)) {
    return `${moved} dos ${ids.size} embaixadores com desconto mudavam de nível de uma vez.`;
  }
  return null;
}
