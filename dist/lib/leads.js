/**
 * Purchase-check and identity lookups for the Leads a contactar pipeline
 * (src/crons/leads-reconcile.ts, the disabled src/crons/leads-email-scan.ts,
 * and eventually the still-blocked WhatsApp/Instagram webhook path — see
 * docs/plans/leads-whatsapp-instagram.md on the worktree-cuddly-skipping-taco
 * branch). A lead only gets written to Notion if this says they never
 * purchased anything — writing a real paying customer as a "lead" would be
 * an embarrassing miss.
 *
 * Both answers come from the studio's views (docs/plans/2026-09-21-pulse-views-spec.md):
 * - "ever paid?" = a row in v_pulse_first_paid (a Paid payment or a sale
 *   item with total_sales > 0; absent = a lead). Replaced the bot's own
 *   two-table count 2026-09-21.
 * - name / email / phone = v_pulse_member_identity, the one PII view,
 *   joined on member_id = md5(lower(email)). Staff and test accounts are
 *   already excluded there.
 */
import { scoreMatch } from "./fuzzy-match.js";
import { log } from "./log.js";
import { fetchMemberActivity, fetchMemberIdentity, hasEverPaid, memberIdFromEmail } from "./pulse-views.js";
import { isStudioDbAvailable } from "./studio-db.js";
const FUZZY_MATCH_THRESHOLD = 0.5;
/**
 * Every name/email/phone the identity view has, fetched once per caller
 * (e.g. once per cron run) and passed into the pure lookups below.
 */
export async function fetchAllCustomerNames() {
    if (!isStudioDbAvailable()) {
        log.warn("leads.fetch_customers_skipped", { reason: "studio_db_not_configured" });
        return [];
    }
    const rows = await fetchMemberIdentity();
    return rows
        .filter((r) => r.contact_name)
        .map((r) => ({
        name: r.contact_name,
        email: r.contact_email ?? null,
        phone: r.contact_phone ?? null,
    }));
}
/**
 * Pure — no I/O. Exact (case-insensitive) email match against `customers`
 * for a phone number, if the identity view has one on file. Independent of
 * the purchase check — the identity view includes leads alongside real
 * customers, so a phone can be on file even for someone who never bought
 * anything.
 */
export function findPhoneByEmail(email, customers) {
    if (!email)
        return null;
    const normalized = email.trim().toLowerCase();
    const match = customers.find((c) => c.email && c.email.trim().toLowerCase() === normalized);
    return match?.phone ?? null;
}
/**
 * True if `email` has a real, paid purchase on file (v_pulse_first_paid) —
 * the same check used before writing a new lead, also reused by
 * src/crons/leads-reconcile.ts to auto-archive an already-open lead the
 * moment they convert. The input is trimmed (a Notion/email-scan value may
 * carry whitespace); the view's key never is.
 */
export async function hasRealPurchase(email) {
    if (!isStudioDbAvailable())
        return false;
    return hasEverPaid(memberIdFromEmail(email.trim()));
}
/**
 * Pure — no I/O. Best fuzzy match of `name` against `customers`, above
 * FUZZY_MATCH_THRESHOLD, or null if nothing clears the bar. Exported for
 * unit testing without a database call.
 */
export function findBestNameMatch(name, customers) {
    let best = null;
    for (const c of customers) {
        const score = scoreMatch(c.name, name);
        if (score >= FUZZY_MATCH_THRESHOLD && (!best || score > best.score)) {
            best = { name: c.name, email: c.email, score };
        }
    }
    return best;
}
/**
 * Every member's visit history (v_pulse_member_activity), fetched once per
 * caller and reused across every candidate checked — same fetch-once
 * pattern as fetchAllCustomerNames. Keyed by member_id (md5(lower(email)))
 * so a caller with a candidate email can look themselves up via
 * memberIdFromEmail without a second query.
 */
export async function fetchAllVisitHistory() {
    if (!isStudioDbAvailable()) {
        log.warn("leads.fetch_visit_history_skipped", { reason: "studio_db_not_configured" });
        return new Map();
    }
    const rows = await fetchMemberActivity();
    return new Map(rows.map((r) => [
        r.member_id,
        { firstVisit: r.first_visit, lastVisit: r.last_visit, visitCount: r.visit_count },
    ]));
}
/** Pure — no I/O. `email` may be null (no email on file for this contact),
 * in which case there's nothing to look up. */
export function findVisitHistory(email, activity) {
    if (!email)
        return null;
    return activity.get(memberIdFromEmail(email.trim())) ?? null;
}
export async function checkExistingCustomer(email, name, customers) {
    if (email) {
        const purchased = await hasRealPurchase(email);
        if (purchased) {
            return { isExistingCustomer: true, fuzzyMatch: null };
        }
    }
    return { isExistingCustomer: false, fuzzyMatch: findBestNameMatch(name, customers) };
}
