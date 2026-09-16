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
import { fetchAllCustomerNames, findPhoneByEmail } from "./leads.js";
import { log } from "./log.js";
import { fetchAllPages, studioSupabase } from "./studio-supabase.js";
// The only 3 intro-pack products with real volume (see kenko_product_catalogue
// revenue_bucket='intro_packs' — the rest, "Open Day" one-off events etc.,
// are too low-volume to matter here).
export const INTRO_PACK_NAMES = [
    "2 Classes + Free Socks | Premium",
    "2 Classes | Premium",
    "10-Day Unlimited Pass",
];
export const DEFAULT_CUTOFF_DAYS = 21;
async function fetchIntroPackFinishers() {
    if (!studioSupabase)
        return [];
    const rows = await fetchAllPages((from, to) => studioSupabase
        .from("kenko_memberships")
        .select("contact_email, contact_name, membership_name, membership_starts_at, membership_expires_at")
        .in("membership_name", [...INTRO_PACK_NAMES])
        .eq("membership_status", "Expired")
        .not("membership_expires_at", "is", null)
        .range(from, to));
    return rows
        .filter((r) => r.contact_email && r.membership_starts_at && r.membership_expires_at)
        .map((r) => ({
        email: r.contact_email.toLowerCase().trim(),
        name: r.contact_name || r.contact_email,
        packName: r.membership_name,
        startsAt: new Date(r.membership_starts_at),
        expiresAt: new Date(r.membership_expires_at),
    }));
}
/** email (lowercased) -> every subscription_starts_at ever seen for them. */
async function fetchAllSubscriptionStarts() {
    if (!studioSupabase)
        return new Map();
    const rows = await fetchAllPages((from, to) => studioSupabase
        .from("kenko_subscriptions")
        .select("contact_email, subscription_starts_at")
        .not("subscription_starts_at", "is", null)
        .range(from, to));
    const map = new Map();
    for (const r of rows) {
        if (!r.contact_email)
            continue;
        const email = r.contact_email.toLowerCase().trim();
        const list = map.get(email) ?? [];
        list.push(new Date(r.subscription_starts_at));
        map.set(email, list);
    }
    return map;
}
/** email (lowercased) -> every non-intro-pack membership_starts_at ever seen. */
async function fetchAllNonIntroMembershipStarts() {
    if (!studioSupabase)
        return new Map();
    const rows = await fetchAllPages((from, to) => studioSupabase
        .from("kenko_memberships")
        .select("contact_email, membership_name, membership_starts_at")
        .not("membership_starts_at", "is", null)
        .range(from, to));
    const introNames = new Set(INTRO_PACK_NAMES);
    const map = new Map();
    for (const r of rows) {
        if (!r.contact_email || !r.membership_name)
            continue;
        if (introNames.has(r.membership_name))
            continue;
        const email = r.contact_email.toLowerCase().trim();
        const list = map.get(email) ?? [];
        list.push(new Date(r.membership_starts_at));
        map.set(email, list);
    }
    return map;
}
/**
 * email (lowercased) -> attendance stats, counting only checkin_status =
 * "Yes" (an actual attended class, not just a reservation made).
 */
async function fetchVisitHistory() {
    if (!studioSupabase)
        return new Map();
    const rows = await fetchAllPages((from, to) => studioSupabase
        .from("kenko_bookings")
        .select("contact_email, event_date, checkin_status")
        .eq("checkin_status", "Yes")
        .range(from, to));
    const map = new Map();
    for (const r of rows) {
        if (!r.contact_email || !r.event_date)
            continue;
        const email = r.contact_email.toLowerCase().trim();
        const eventDate = new Date(r.event_date);
        const existing = map.get(email);
        if (!existing) {
            map.set(email, { lastVisit: eventDate, count: 1 });
        }
        else {
            existing.count += 1;
            if (eventDate > existing.lastVisit)
                existing.lastVisit = eventDate;
        }
    }
    return map;
}
// Exported for unit testing without a Supabase call.
export function hasConvertedAfter(email, after, subsByEmail, membershipsByEmail) {
    const subs = subsByEmail.get(email) ?? [];
    const mems = membershipsByEmail.get(email) ?? [];
    return subs.some((d) => d > after) || mems.some((d) => d > after);
}
// Exported for src/crons/leads-reconcile.ts, which needs the same
// subs/memberships lookup to check "did this specific Intro Pack lead
// convert after THEIR pack's expiry" — a per-email question hasRealPurchase
// can't answer, since it treats the intro-pack purchase itself as a
// conversion.
export async function loadConversionCheckData() {
    const [introRows, subsByEmail, membershipsByEmail, visitsByEmail, customers] = await Promise.all([
        fetchIntroPackFinishers(),
        fetchAllSubscriptionStarts(),
        fetchAllNonIntroMembershipStarts(),
        fetchVisitHistory(),
        fetchAllCustomerNames(),
    ]);
    // First intro pack per person — a second/later intro pack purchase would
    // otherwise re-anchor the clock, which isn't the question being asked.
    const firstPackByEmail = new Map();
    for (const row of introRows) {
        if (isExcludedEmail(row.email))
            continue;
        const existing = firstPackByEmail.get(row.email);
        if (!existing || row.startsAt < existing.startsAt) {
            firstPackByEmail.set(row.email, row);
        }
    }
    return { firstPackByEmail, subsByEmail, membershipsByEmail, visitsByEmail, customers };
}
function toUnconverted(row, now, visitsByEmail, customers) {
    const daysSinceExpiry = (now.getTime() - row.expiresAt.getTime()) / 86_400_000;
    const visits = visitsByEmail.get(row.email);
    return {
        email: row.email,
        name: row.name,
        phone: findPhoneByEmail(row.email, customers),
        packName: row.packName,
        expiresAt: row.expiresAt,
        daysSinceExpiry: Math.round(daysSinceExpiry),
        lastVisit: visits?.lastVisit ?? null,
        visitCount: visits?.count ?? 0,
    };
}
/**
 * Standing weekly signal: intro pack finished at least `cutoffDays` ago
 * (default 21, validated for both real pack types — no need to split),
 * and the person never activated anything else since.
 */
export async function findUnconvertedIntroPacks(cutoffDays = DEFAULT_CUTOFF_DAYS, now = new Date()) {
    if (!studioSupabase) {
        log.warn("intro_pack_conversion.fetch_skipped", { reason: "studio_supabase_not_configured" });
        return [];
    }
    const { firstPackByEmail, subsByEmail, membershipsByEmail, visitsByEmail, customers } = await loadConversionCheckData();
    const out = [];
    for (const row of firstPackByEmail.values()) {
        if (hasConvertedAfter(row.email, row.expiresAt, subsByEmail, membershipsByEmail))
            continue;
        const daysSinceExpiry = (now.getTime() - row.expiresAt.getTime()) / 86_400_000;
        if (daysSinceExpiry >= cutoffDays) {
            out.push(toUnconverted(row, now, visitsByEmail, customers));
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
export async function findUnconvertedIntroPacksInRange(fromISO, toISO, now = new Date()) {
    if (!studioSupabase) {
        log.warn("intro_pack_conversion.fetch_skipped", { reason: "studio_supabase_not_configured" });
        return [];
    }
    const from = new Date(fromISO);
    const to = new Date(toISO);
    const { firstPackByEmail, subsByEmail, membershipsByEmail, visitsByEmail, customers } = await loadConversionCheckData();
    const out = [];
    for (const row of firstPackByEmail.values()) {
        if (row.expiresAt < from || row.expiresAt >= to)
            continue;
        if (hasConvertedAfter(row.email, row.expiresAt, subsByEmail, membershipsByEmail))
            continue;
        out.push(toUnconverted(row, now, visitsByEmail, customers));
    }
    return out;
}
