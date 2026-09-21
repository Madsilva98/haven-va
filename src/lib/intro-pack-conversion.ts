/**
 * Intro packs, from the studio's views (spec docs/plans/2026-09-21-pulse-views-spec.md):
 * - v_pulse_intro_purchase: one row per pack sold; intro_end is Kenko's own
 *   expiry from the ledger when the sale matched a pack (a hand-edited date
 *   shows up here: Carla Costa, 10-Day valid to 8 Sep not 1 Sep, case #7),
 *   else modeled — never compute purchase + 10/21 here.
 * - v_pulse_intro_conversion: converted (a 4x/8x/12x/Unlimited subscription
 *   on or after the purchase — mid-pack counts, Sofia Orellana, case #8) or
 *   converted_pack (a real 5x/10x pack; a drop-in is not a conversion, case
 *   #9). Either one means "never chase as a lead".
 * - v_pulse_member_activity: last_visit / visit_count (checkin_status Yes
 *   alone, Roberta Dias, case #10).
 * - v_pulse_member_identity: name and phone, on member_id.
 * Only 2-Class and 10-Day packs are tracked here — the ones with real
 * volume, founder's scope; the view also labels 5-Class / Open Day /
 * Intro other, which are left alone.
 *
 * Day-21 threshold: empirically validated in session (see git history of
 * this file) — nobody in the 10-Day cohort converts between days 17-21, so
 * waiting costs it nothing and cuts false outreach for the 2-Class cohort.
 * Used by src/crons/leads-intro-pack.ts, src/crons/leads-reconcile.ts,
 * src/crons/intro-pack-expiring.ts and the one-off scripts/ backfills.
 */

import { fetchAllCustomerNames, findPhoneByEmail, type CustomerNameRecord } from "./leads.js";
import { log } from "./log.js";
import {
  fetchIntroConversion,
  fetchIntroPurchases,
  fetchMemberActivity,
  memberIdFromEmail,
  type IntroPurchaseRow,
  type MemberActivityRow,
} from "./pulse-views.js";
import { isStudioDbAvailable } from "./studio-db.js";
import { lisbonDateString, lisbonNaiveToUtcIso } from "./tz.js";

/** The view's `pack` labels this bot tracks. */
export const TRACKED_PACKS = ["2-Class", "10-Day"] as const;
export type TrackedPack = (typeof TRACKED_PACKS)[number];

export const DEFAULT_CUTOFF_DAYS = 21;

export interface UnconvertedIntroPack {
  email: string;
  name: string;
  phone: string | null;
  pack: TrackedPack;
  packName: string; // the item as sold, e.g. "2 Classes | Premium"
  expiresAt: Date;
  daysSinceExpiry: number;
  lastVisit: Date | null; // last checked-in class, any time
  visitCount: number; // checked-in classes, any time
}

export interface IntroPackRow {
  memberId: string;
  email: string;
  name: string;
  pack: TrackedPack;
  packName: string;
  purchasedAt: Date;
  expiresAt: Date; // end of the intro_end day in Lisbon, so a visit that day is still "during"
}

function lisbonEndOfDay(dateStr: string): Date {
  return new Date(lisbonNaiveToUtcIso(`${dateStr.slice(0, 10)}T23:59:59`));
}
function lisbonNoon(dateStr: string): Date {
  return new Date(lisbonNaiveToUtcIso(`${dateStr.slice(0, 10)}T12:00:00`));
}

function isTracked(pack: string): pack is TrackedPack {
  return (TRACKED_PACKS as readonly string[]).includes(pack);
}

function nameByMemberId(customers: CustomerNameRecord[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const c of customers) if (c.email && c.name) out.set(memberIdFromEmail(c.email), c.name);
  return out;
}

/**
 * Pure — no I/O. First tracked pack per person (earliest intro_purchase),
 * keyed by lower-cased email. Open Day / Valentine / "for members" sales
 * are not intro packs for this purpose.
 */
export function selectFirstTrackedPacks(
  rows: IntroPurchaseRow[],
  customers: CustomerNameRecord[],
): Map<string, IntroPackRow> {
  const names = nameByMemberId(customers);
  const out = new Map<string, IntroPackRow>();
  for (const r of rows) {
    if (!isTracked(r.pack) || r.is_open_day || r.is_valentine || r.is_for_members) continue;
    const email = r.email.toLowerCase();
    const purchasedAt = lisbonNoon(r.intro_purchase);
    const existing = out.get(email);
    if (existing && existing.purchasedAt <= purchasedAt) continue;
    out.set(email, {
      memberId: r.member_id,
      email,
      name: names.get(r.member_id) ?? email,
      pack: r.pack,
      packName: r.item_name,
      purchasedAt,
      expiresAt: lisbonEndOfDay(r.intro_end),
    });
  }
  return out;
}

interface VisitStats {
  lastVisit: Date | null;
  count: number;
}

function visitStats(rows: MemberActivityRow[]): Map<string, VisitStats> {
  const out = new Map<string, VisitStats>();
  for (const r of rows) {
    out.set(r.member_id, { lastVisit: r.last_visit ? lisbonNoon(r.last_visit) : null, count: r.visit_count });
  }
  return out;
}

/**
 * If the person visited again (a checked-in class) after their own pack's
 * expiry date but never converted, that's a meaningfully different signal
 * from total silence — a paid drop-in return — and reads as contradictory
 * next to a plain "sem converter" if left unsaid (caught by the founder on
 * Liza Kupriievych: pack expired 16/07, came back for a one-off Yin Yoga
 * drop-in on 25/08, never bought a plan). Returns null when there's
 * nothing to add.
 */
export function describePostExpiryVisit(
  c: Pick<UnconvertedIntroPack, "expiresAt" | "lastVisit">,
): string | null {
  if (!c.lastVisit || c.lastVisit <= c.expiresAt) return null;
  const formatted = c.lastVisit.toLocaleDateString("pt-PT", { timeZone: "Europe/Lisbon" });
  return `voltou depois disso (última visita a ${formatted}), mas sem fazer plano`;
}

export interface ConversionCheckData {
  firstPackByEmail: Map<string, IntroPackRow>;
  convertedMemberIds: Set<string>; // converted OR converted_pack
  visitsByMember: Map<string, VisitStats>;
  customers: CustomerNameRecord[];
}

// Exported for src/crons/leads-reconcile.ts, which asks the same "did this
// Intro Pack lead convert" question for rows already in Notion.
export async function loadConversionCheckData(): Promise<ConversionCheckData> {
  const [purchases, conversions, activity, customers] = await Promise.all([
    fetchIntroPurchases(),
    fetchIntroConversion(),
    fetchMemberActivity(),
    fetchAllCustomerNames(),
  ]);
  return {
    firstPackByEmail: selectFirstTrackedPacks(purchases, customers),
    convertedMemberIds: new Set(conversions.filter((c) => c.converted || c.converted_pack).map((c) => c.member_id)),
    visitsByMember: visitStats(activity),
    customers,
  };
}

function toUnconverted(
  row: IntroPackRow,
  now: Date,
  visitsByMember: Map<string, VisitStats>,
  customers: CustomerNameRecord[],
): UnconvertedIntroPack {
  const visits = visitsByMember.get(row.memberId);
  return {
    email: row.email,
    name: row.name,
    phone: findPhoneByEmail(row.email, customers),
    pack: row.pack,
    packName: row.packName,
    expiresAt: row.expiresAt,
    daysSinceExpiry: Math.round((now.getTime() - row.expiresAt.getTime()) / 86_400_000),
    lastVisit: visits?.lastVisit ?? null,
    visitCount: visits?.count ?? 0,
  };
}

/**
 * Standing weekly signal: intro pack finished at least `cutoffDays` ago
 * (default 21) and the person never converted since.
 */
export async function findUnconvertedIntroPacks(
  cutoffDays: number = DEFAULT_CUTOFF_DAYS,
  now: Date = new Date(),
): Promise<UnconvertedIntroPack[]> {
  if (!isStudioDbAvailable()) {
    log.warn("intro_pack_conversion.fetch_skipped", { reason: "studio_db_not_configured" });
    return [];
  }
  const { firstPackByEmail, convertedMemberIds, visitsByMember, customers } = await loadConversionCheckData();
  const out: UnconvertedIntroPack[] = [];
  for (const row of firstPackByEmail.values()) {
    if (convertedMemberIds.has(row.memberId)) continue;
    const daysSinceExpiry = (now.getTime() - row.expiresAt.getTime()) / 86_400_000;
    if (daysSinceExpiry >= cutoffDays) out.push(toUnconverted(row, now, visitsByMember, customers));
  }
  return out;
}

export interface ExpiringIntroPackToWatch {
  email: string;
  name: string;
  phone: string | null;
  pack: TrackedPack;
  packName: string;
  expiresAt: Date;
  visitCount: number;
}

/**
 * Intro packs whose intro_end falls within `daysAhead` days (default 3),
 * filtered to the two usage patterns worth a proactive nudge before the
 * pack lapses — founder's spec, 2026-09-20, not empirically derived like
 * DEFAULT_CUTOFF_DAYS above:
 * - 2-Class: exactly 1 of the 2 classes attended so far.
 * - 10-Day: more than 5 classes attended already.
 * Used by src/crons/intro-pack-expiring.ts.
 */
export async function findExpiringIntroPacksToWatch(
  daysAhead = 3,
  now: Date = new Date(),
): Promise<ExpiringIntroPackToWatch[]> {
  if (!isStudioDbAvailable()) {
    log.warn("intro_pack_expiring.fetch_skipped", { reason: "studio_db_not_configured" });
    return [];
  }
  const today = lisbonDateString(now);
  const until = lisbonDateString(new Date(now.getTime() + daysAhead * 86_400_000));
  const [purchases, activity, customers] = await Promise.all([
    fetchIntroPurchases(),
    fetchMemberActivity(),
    fetchAllCustomerNames(),
  ]);
  const visitsByMember = visitStats(activity);
  const names = nameByMemberId(customers);

  const out: ExpiringIntroPackToWatch[] = [];
  for (const r of purchases) {
    if (!isTracked(r.pack) || r.is_open_day || r.is_valentine || r.is_for_members) continue;
    if (r.intro_end < today || r.intro_end > until) continue;
    const visitCount = visitsByMember.get(r.member_id)?.count ?? 0;
    if (r.pack === "2-Class" && visitCount !== 1) continue;
    if (r.pack === "10-Day" && visitCount <= 5) continue;
    const email = r.email.toLowerCase();
    out.push({
      email,
      name: names.get(r.member_id) ?? email,
      phone: findPhoneByEmail(email, customers),
      pack: r.pack,
      packName: r.item_name,
      expiresAt: lisbonEndOfDay(r.intro_end),
      visitCount,
    });
  }
  out.sort((a, b) => a.expiresAt.getTime() - b.expiresAt.getTime());
  return out;
}

/**
 * One-off backfill helper (scripts/backfill-intro-pack-summer-2026.mjs):
 * everyone whose intro pack expired within [fromISO, toISO) and never
 * converted, with NO day-count gate — the founder asked for this specific
 * window caught immediately, a one-time exception for the summer effect.
 */
export async function findUnconvertedIntroPacksInRange(
  fromISO: string,
  toISO: string,
  now: Date = new Date(),
): Promise<UnconvertedIntroPack[]> {
  if (!isStudioDbAvailable()) {
    log.warn("intro_pack_conversion.fetch_skipped", { reason: "studio_db_not_configured" });
    return [];
  }
  const from = new Date(fromISO);
  const to = new Date(toISO);
  const { firstPackByEmail, convertedMemberIds, visitsByMember, customers } = await loadConversionCheckData();
  const out: UnconvertedIntroPack[] = [];
  for (const row of firstPackByEmail.values()) {
    if (row.expiresAt < from || row.expiresAt >= to) continue;
    if (convertedMemberIds.has(row.memberId)) continue;
    out.push(toUnconverted(row, now, visitsByMember, customers));
  }
  return out;
}
