/**
 * Purchase-check for the Leads a contactar pipeline (src/crons/leads-email-scan.ts,
 * and eventually the still-blocked WhatsApp/Instagram webhook path — see
 * docs/plans/leads-whatsapp-instagram.md on the worktree-cuddly-skipping-taco
 * branch). A lead only gets written to Notion if this says they never
 * purchased anything — writing a real paying customer as a "lead" would be
 * an embarrassing miss, so this checks BOTH kenko_payments and
 * kenko_sale_items rather than trusting either alone.
 */
import { scoreMatch } from "./fuzzy-match.js";
import { log } from "./log.js";
import { studioSupabase } from "./studio-supabase.js";
const FUZZY_MATCH_THRESHOLD = 0.5;
/**
 * Every kenko_customers name/email, fetched once per caller (e.g. once per
 * cron run) and passed into checkExistingCustomer — same "small enough to
 * pull whole and filter client-side" reasoning as src/lib/birthdays.ts.
 */
export async function fetchAllCustomerNames() {
    if (!studioSupabase) {
        log.warn("leads.fetch_customers_skipped", { reason: "studio_supabase_not_configured" });
        return [];
    }
    const { data, error } = await studioSupabase
        .from("kenko_customers")
        .select("contact_name, contact_email, contact_phone");
    if (error) {
        throw new Error(`leads: kenko_customers query failed: ${error.message}`);
    }
    return (data ?? [])
        .filter((r) => r.contact_name)
        .map((r) => ({
        name: r.contact_name,
        email: r.contact_email ?? null,
        phone: r.contact_phone ?? null,
    }));
}
/**
 * Pure — no I/O. Exact (case-insensitive) email match against `customers`
 * for a phone number, if `kenko_customers` has one on file. Independent of
 * the purchase check — `kenko_customers` includes Leads alongside real
 * customers (see src/lib/studio-supabase.ts), so a phone can be on file
 * even for someone who never bought anything.
 */
export function findPhoneByEmail(email, customers) {
    if (!email)
        return null;
    const normalized = email.trim().toLowerCase();
    const match = customers.find((c) => c.email && c.email.trim().toLowerCase() === normalized);
    return match?.phone ?? null;
}
async function hasRealPurchase(email) {
    if (!studioSupabase)
        return false;
    const normalized = email.trim().toLowerCase();
    const [paymentsRes, saleItemsRes] = await Promise.all([
        studioSupabase
            .from("kenko_payments")
            .select("id", { count: "exact", head: true })
            .ilike("contact_email", normalized)
            .eq("payment_status", "Paid"),
        studioSupabase
            .from("kenko_sale_items")
            .select("id", { count: "exact", head: true })
            .ilike("contact_email", normalized)
            .eq("sale_type", "Purchase")
            .gt("total_sales", 0),
    ]);
    if (paymentsRes.error)
        throw new Error(`leads: kenko_payments query failed: ${paymentsRes.error.message}`);
    if (saleItemsRes.error)
        throw new Error(`leads: kenko_sale_items query failed: ${saleItemsRes.error.message}`);
    return (paymentsRes.count ?? 0) > 0 || (saleItemsRes.count ?? 0) > 0;
}
/**
 * Pure — no I/O. Best fuzzy match of `name` against `customers`, above
 * FUZZY_MATCH_THRESHOLD, or null if nothing clears the bar. Exported for
 * unit testing without a Supabase call.
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
 * `customers` must be a recent fetchAllCustomerNames() result — the caller
 * fetches it once per run and reuses it across every email/name checked,
 * rather than refetching per candidate.
 */
export async function checkExistingCustomer(email, name, customers) {
    if (email) {
        const purchased = await hasRealPurchase(email);
        if (purchased) {
            return { isExistingCustomer: true, fuzzyMatch: null };
        }
    }
    return { isExistingCustomer: false, fuzzyMatch: findBestNameMatch(name, customers) };
}
