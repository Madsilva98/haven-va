/**
 * Finds people who finished an intro pack and never converted to a real
 * membership/pack — for src/crons/leads-intro-pack.ts and the one-off
 * scripts/backfill-intro-pack-summer-2026.mjs.
 *
 * Day-21 threshold and the "don't split by pack type" call were both
 * empirically validated in session: comparing how many eventual converters
 * were still converting organically after each candidate day, day 21 turned
 * out to serve both real intro-pack products equally well (nobody in the
 * 10-Day Unlimited cohort converts between days 17-21 at all, so waiting
 * costs it nothing; it meaningfully reduces false "why didn't you convert"
 * outreach for the 2 Classes cohort). See docs/knowledge-base for the
 * session notes if this ever needs re-deriving.
 */

import { isExcludedEmail } from "./churn-signals.js";
import { log } from "./log.js";
import { studioSupabase } from "./studio-supabase.js";

// The only 3 intro-pack products with real volume (see kenko_product_catalogue
// revenue_bucket='intro_packs' — the rest, "Open Day" one-off events etc.,
// are too low-volume to matter here).
export const INTRO_PACK_NAMES = [
  "2 Classes + Free Socks | Premium",
  "2 Classes | Premium",
  "10-Day Unlimited Pass",
] as const;

export const DEFAULT_CUTOFF_DAYS = 21;

export interface UnconvertedIntroPack {
  email: string;
  name: string;
  packName: string;
  expiresAt: Date;
  daysSinceExpiry: number;
}

interface IntroPackRow {
  email: string;
  name: string;
  packName: string;
  startsAt: Date;
  expiresAt: Date;
}

async function fetchIntroPackFinishers(): Promise<IntroPackRow[]> {
  if (!studioSupabase) return [];
  const { data, error } = await studioSupabase
    .from("kenko_memberships")
    .select("contact_email, contact_name, membership_name, membership_starts_at, membership_expires_at")
    .in("membership_name", [...INTRO_PACK_NAMES])
    .eq("membership_status", "Expired")
    .not("membership_expires_at", "is", null);
  if (error) throw new Error(`intro_pack_conversion: kenko_memberships query failed: ${error.message}`);
  return (data ?? [])
    .filter((r) => r.contact_email && r.membership_starts_at && r.membership_expires_at)
    .map((r) => ({
      email: (r.contact_email as string).toLowerCase().trim(),
      name: (r.contact_name as string | null) || (r.contact_email as string),
      packName: r.membership_name as string,
      startsAt: new Date(r.membership_starts_at as string),
      expiresAt: new Date(r.membership_expires_at as string),
    }));
}

/** email (lowercased) -> every subscription_starts_at ever seen for them. */
async function fetchAllSubscriptionStarts(): Promise<Map<string, Date[]>> {
  if (!studioSupabase) return new Map();
  const { data, error } = await studioSupabase
    .from("kenko_subscriptions")
    .select("contact_email, subscription_starts_at")
    .not("subscription_starts_at", "is", null);
  if (error) throw new Error(`intro_pack_conversion: kenko_subscriptions query failed: ${error.message}`);
  const map = new Map<string, Date[]>();
  for (const r of data ?? []) {
    if (!r.contact_email) continue;
    const email = (r.contact_email as string).toLowerCase().trim();
    const list = map.get(email) ?? [];
    list.push(new Date(r.subscription_starts_at as string));
    map.set(email, list);
  }
  return map;
}

/** email (lowercased) -> every non-intro-pack membership_starts_at ever seen. */
async function fetchAllNonIntroMembershipStarts(): Promise<Map<string, Date[]>> {
  if (!studioSupabase) return new Map();
  const { data, error } = await studioSupabase
    .from("kenko_memberships")
    .select("contact_email, membership_name, membership_starts_at")
    .not("membership_starts_at", "is", null);
  if (error) throw new Error(`intro_pack_conversion: kenko_memberships (non-intro) query failed: ${error.message}`);
  const introNames = new Set<string>(INTRO_PACK_NAMES);
  const map = new Map<string, Date[]>();
  for (const r of data ?? []) {
    if (!r.contact_email || !r.membership_name) continue;
    if (introNames.has(r.membership_name as string)) continue;
    const email = (r.contact_email as string).toLowerCase().trim();
    const list = map.get(email) ?? [];
    list.push(new Date(r.membership_starts_at as string));
    map.set(email, list);
  }
  return map;
}

// Exported for unit testing without a Supabase call.
export function hasConvertedAfter(
  email: string,
  after: Date,
  subsByEmail: Map<string, Date[]>,
  membershipsByEmail: Map<string, Date[]>,
): boolean {
  const subs = subsByEmail.get(email) ?? [];
  const mems = membershipsByEmail.get(email) ?? [];
  return subs.some((d) => d > after) || mems.some((d) => d > after);
}

interface ConversionCheckData {
  firstPackByEmail: Map<string, IntroPackRow>;
  subsByEmail: Map<string, Date[]>;
  membershipsByEmail: Map<string, Date[]>;
}

async function loadConversionCheckData(): Promise<ConversionCheckData> {
  const [introRows, subsByEmail, membershipsByEmail] = await Promise.all([
    fetchIntroPackFinishers(),
    fetchAllSubscriptionStarts(),
    fetchAllNonIntroMembershipStarts(),
  ]);

  // First intro pack per person — a second/later intro pack purchase would
  // otherwise re-anchor the clock, which isn't the question being asked.
  const firstPackByEmail = new Map<string, IntroPackRow>();
  for (const row of introRows) {
    if (isExcludedEmail(row.email)) continue;
    const existing = firstPackByEmail.get(row.email);
    if (!existing || row.startsAt < existing.startsAt) {
      firstPackByEmail.set(row.email, row);
    }
  }

  return { firstPackByEmail, subsByEmail, membershipsByEmail };
}

function toUnconverted(row: IntroPackRow, now: Date): UnconvertedIntroPack {
  const daysSinceExpiry = (now.getTime() - row.expiresAt.getTime()) / 86_400_000;
  return {
    email: row.email,
    name: row.name,
    packName: row.packName,
    expiresAt: row.expiresAt,
    daysSinceExpiry: Math.round(daysSinceExpiry),
  };
}

/**
 * Standing weekly signal: intro pack finished at least `cutoffDays` ago
 * (default 21, validated for both real pack types — no need to split),
 * and the person never activated anything else since.
 */
export async function findUnconvertedIntroPacks(
  cutoffDays: number = DEFAULT_CUTOFF_DAYS,
  now: Date = new Date(),
): Promise<UnconvertedIntroPack[]> {
  if (!studioSupabase) {
    log.warn("intro_pack_conversion.fetch_skipped", { reason: "studio_supabase_not_configured" });
    return [];
  }
  const { firstPackByEmail, subsByEmail, membershipsByEmail } = await loadConversionCheckData();
  const out: UnconvertedIntroPack[] = [];
  for (const row of firstPackByEmail.values()) {
    if (hasConvertedAfter(row.email, row.expiresAt, subsByEmail, membershipsByEmail)) continue;
    const daysSinceExpiry = (now.getTime() - row.expiresAt.getTime()) / 86_400_000;
    if (daysSinceExpiry >= cutoffDays) {
      out.push(toUnconverted(row, now));
    }
  }
  return out;
}

/**
 * One-off backfill helper (scripts/backfill-intro-pack-summer-2026.mjs):
 * everyone whose intro pack expired within [fromISO, toISO) and never
 * converted, with NO day-count gate — the founder asked for this specific
 * window caught immediately, acknowledging the summer/vacation effect on
 * conversion timing as a one-time exception, not a standing seasonal rule.
 */
export async function findUnconvertedIntroPacksInRange(
  fromISO: string,
  toISO: string,
  now: Date = new Date(),
): Promise<UnconvertedIntroPack[]> {
  if (!studioSupabase) {
    log.warn("intro_pack_conversion.fetch_skipped", { reason: "studio_supabase_not_configured" });
    return [];
  }
  const from = new Date(fromISO);
  const to = new Date(toISO);
  const { firstPackByEmail, subsByEmail, membershipsByEmail } = await loadConversionCheckData();
  const out: UnconvertedIntroPack[] = [];
  for (const row of firstPackByEmail.values()) {
    if (row.expiresAt < from || row.expiresAt >= to) continue;
    if (hasConvertedAfter(row.email, row.expiresAt, subsByEmail, membershipsByEmail)) continue;
    out.push(toUnconverted(row, now));
  }
  return out;
}
