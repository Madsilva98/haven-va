/**
 * Intro packs, from the studio's views (spec docs/plans/2026-09-21-pulse-views-spec.md):
 * - v_pulse_intro_purchase: one row per pack sold; intro_end is Kenko's own
 *   expiry from the ledger when the sale matched a pack (a hand-edited date
 *   shows up here: Carla Costa, 10-Day valid to 8 Sep not 1 Sep, case #7),
 *   else modeled — never compute purchase + 10/21 here. Only is_activated
 *   = true rows have a real intro_end: false = bought and never came (a
 *   segment of its own, not an ended pack — case #25), NULL = unmatched.
 * - v_pulse_intro_conversion: converted (a 4x/8x/12x/Unlimited subscription
 *   on or after the purchase — mid-pack counts, Sofia Orellana, case #8) or
 *   converted_pack (a real 5x/10x pack; a drop-in is not a conversion, case
 *   #9). Either one means "never chase as a lead".
 * - v_pulse_member_activity: last_visit / visit_count (checkin_status Yes
 *   alone, Roberta Dias, case #10) — lifetime, for the "voltou depois"
 *   note. Pack use is v_pulse_intro_purchase.visits_in_pack.
 * - v_pulse_member_identity: name and phone, on member_id.
 * - v_pulse_data_as_of: the one "today" every comparison and every
 *   "dados até" line uses — EXCEPT findExpiringIntroPacksToWatch's window
 *   below, see its own comment for why.
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
  fetchDataAsOf,
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
  activated: boolean; // is_activated = true: the pack ran, so intro_end is a real expiry
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
      activated: r.is_activated === true,
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
  asOf: string | null; // v_pulse_data_as_of
  firstPackByEmail: Map<string, IntroPackRow>;
  convertedMemberIds: Set<string>; // converted OR converted_pack
  visitsByMember: Map<string, VisitStats>;
  customers: CustomerNameRecord[];
}

// Exported for src/crons/leads-reconcile.ts, which asks the same "did this
// Intro Pack lead convert" question for rows already in Notion.
export async function loadConversionCheckData(): Promise<ConversionCheckData> {
  const [asOf, purchases, conversions, activity, customers] = await Promise.all([
    fetchDataAsOf(),
    fetchIntroPurchases(),
    fetchIntroConversion(),
    fetchMemberActivity(),
    fetchAllCustomerNames(),
  ]);
  return {
    asOf,
    firstPackByEmail: selectFirstTrackedPacks(purchases, customers),
    convertedMemberIds: new Set(conversions.filter((c) => c.converted || c.converted_pack).map((c) => c.member_id)),
    visitsByMember: visitStats(activity),
    customers,
  };
}

/** "Now" for every intro-pack comparison: the end of the data-as-of day. */
function asOfInstant(asOf: string): Date {
  return lisbonEndOfDay(asOf);
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
 * (default 21) as of the data date, and the person never converted since.
 *
 * Only packs the view marks is_activated = true. A pack bought and never
 * activated (ledger alive, no expiry, full credits, 0 visits — 32 people on
 * 2026-09-21) has a modeled intro_end that must not read as "terminou há
 * N dias, sem converter" (case #25). Those are "comprou e nunca veio", a
 * segment of its own if Madalena wants one — not leads here.
 */
export async function findUnconvertedIntroPacks(
  cutoffDays: number = DEFAULT_CUTOFF_DAYS,
): Promise<{ candidates: UnconvertedIntroPack[]; asOf: string | null }> {
  if (!isStudioDbAvailable()) {
    log.warn("intro_pack_conversion.fetch_skipped", { reason: "studio_db_not_configured" });
    return { candidates: [], asOf: null };
  }
  const { asOf, firstPackByEmail, convertedMemberIds, visitsByMember, customers } = await loadConversionCheckData();
  if (!asOf) return { candidates: [], asOf: null };
  const now = asOfInstant(asOf);
  const candidates: UnconvertedIntroPack[] = [];
  for (const row of firstPackByEmail.values()) {
    if (!row.activated || convertedMemberIds.has(row.memberId)) continue;
    const daysSinceExpiry = (now.getTime() - row.expiresAt.getTime()) / 86_400_000;
    if (daysSinceExpiry >= cutoffDays) candidates.push(toUnconverted(row, now, visitsByMember, customers));
  }
  return { candidates, asOf };
}

export interface ExpiringIntroPackToWatch {
  email: string;
  name: string;
  phone: string | null;
  pack: TrackedPack;
  packName: string;
  expiresAt: Date;
  visitCount: number; // visits_in_pack — check-ins booked on this pack, not lifetime
}

/** Pure — no I/O. The two usage patterns worth a same-day nudge. */
export function isExpiringPackToWatch(pack: string, visitsInPack: number): boolean {
  if (pack === "2-Class") return visitsInPack === 1;
  if (pack === "10-Day") return visitsInPack > 5;
  return false;
}

/**
 * Pure — no I/O. Whether `introEnd` ("YYYY-MM-DD") falls within the next
 * `daysAhead` days of `today` ("YYYY-MM-DD"), inclusive both ends.
 */
export function isWithinExpiryWindow(introEnd: string, today: string, daysAhead: number): boolean {
  return introEnd >= today && introEnd <= addDays(today, daysAhead);
}

/**
 * Activated intro packs (is_activated = true) whose intro_end falls within
 * `daysAhead` days (default 3) of the REAL calendar date — deliberately NOT
 * `asOf` (`v_pulse_data_as_of`), unlike every other date comparison in this
 * file. `asOf` lags the calendar by design (founder's call, 2026-09-22: the
 * studio's data "will not be fresh every day, at least for now") and
 * `intro_end` is a fixed calendar fact set at purchase time, not a rolling
 * metric that needs `asOf` for internal consistency — so anchoring this
 * window on `asOf` doesn't make it more correct, it just makes "expiring
 * soon" silently mean "already expired" once the lag exceeds `daysAhead`
 * (confirmed in production 2026-09-22: asOf stuck at 2026-09-18, daysAhead=3,
 * so the digest listed packs that had lapsed up to 4 days earlier). `asOf`
 * is still returned/shown in the "dados até" line — only the window itself
 * uses the calendar. Not already converted (a member who bought a plan
 * mid-pack needs no nudge), filtered to the two usage patterns worth a
 * proactive nudge before the pack lapses — founder's spec, 2026-09-20, not
 * empirically derived like DEFAULT_CUTOFF_DAYS above:
 * - 2-Class: exactly 1 of the 2 classes taken ON the pack (visits_in_pack).
 * - 10-Day: more than 5 classes taken on the pack.
 * Used by src/crons/intro-pack-expiring.ts.
 */
export async function findExpiringIntroPacksToWatch(
  daysAhead = 3,
  today: string = lisbonDateString(new Date()),
): Promise<{ packs: ExpiringIntroPackToWatch[]; asOf: string | null }> {
  if (!isStudioDbAvailable()) {
    log.warn("intro_pack_expiring.fetch_skipped", { reason: "studio_db_not_configured" });
    return { packs: [], asOf: null };
  }
  const [asOf, purchases, conversions, customers] = await Promise.all([
    fetchDataAsOf(),
    fetchIntroPurchases(),
    fetchIntroConversion(),
    fetchAllCustomerNames(),
  ]);
  if (!asOf) return { packs: [], asOf: null };
  const converted = new Set(conversions.filter((c) => c.converted || c.converted_pack).map((c) => c.member_id));
  const names = nameByMemberId(customers);

  const packs: ExpiringIntroPackToWatch[] = [];
  for (const r of purchases) {
    if (!isTracked(r.pack) || r.is_open_day || r.is_valentine || r.is_for_members) continue;
    if (r.is_activated !== true) continue;
    if (!isWithinExpiryWindow(r.intro_end, today, daysAhead)) continue;
    if (converted.has(r.member_id)) continue;
    if (!isExpiringPackToWatch(r.pack, r.visits_in_pack)) continue;
    const email = r.email.toLowerCase();
    packs.push({
      email,
      name: names.get(r.member_id) ?? email,
      phone: findPhoneByEmail(email, customers),
      pack: r.pack,
      packName: r.item_name,
      expiresAt: lisbonEndOfDay(r.intro_end),
      visitCount: r.visits_in_pack,
    });
  }
  packs.sort((a, b) => a.expiresAt.getTime() - b.expiresAt.getTime());
  return { packs, asOf };
}

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
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
): Promise<UnconvertedIntroPack[]> {
  if (!isStudioDbAvailable()) {
    log.warn("intro_pack_conversion.fetch_skipped", { reason: "studio_db_not_configured" });
    return [];
  }
  const from = new Date(fromISO);
  const to = new Date(toISO);
  const { asOf, firstPackByEmail, convertedMemberIds, visitsByMember, customers } = await loadConversionCheckData();
  if (!asOf) return [];
  const now = asOfInstant(asOf);
  const out: UnconvertedIntroPack[] = [];
  for (const row of firstPackByEmail.values()) {
    if (!row.activated) continue; // same reason as findUnconvertedIntroPacks
    if (row.expiresAt < from || row.expiresAt >= to) continue;
    if (convertedMemberIds.has(row.memberId)) continue;
    out.push(toUnconverted(row, now, visitsByMember, customers));
  }
  return out;
}
