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
import { fetchMemberIdentity, hasEverPaid, memberIdFromEmail } from "./pulse-views.js";
import { isStudioDbAvailable } from "./studio-db.js";

export interface CustomerNameRecord {
  name: string;
  email: string | null;
  phone: string | null;
}

export interface FuzzyMatch {
  name: string;
  email: string | null;
  score: number;
}

export interface PurchaseCheckResult {
  // true = confirmed existing customer via an exact email match on a real
  // purchase — caller must NOT write this person as a lead.
  isExistingCustomer: boolean;
  // A fuzzy name match never suppresses the write on its own — it only
  // flags the row as "Match incerto — rever manualmente" for a human to
  // check by hand.
  fuzzyMatch: FuzzyMatch | null;
}

const FUZZY_MATCH_THRESHOLD = 0.5;

/**
 * Every name/email/phone the identity view has, fetched once per caller
 * (e.g. once per cron run) and passed into the pure lookups below.
 */
export async function fetchAllCustomerNames(): Promise<CustomerNameRecord[]> {
  if (!isStudioDbAvailable()) {
    log.warn("leads.fetch_customers_skipped", { reason: "studio_db_not_configured" });
    return [];
  }
  const rows = await fetchMemberIdentity();
  return rows
    .filter((r) => r.contact_name)
    .map((r) => ({
      name: r.contact_name!,
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
export function findPhoneByEmail(email: string | null, customers: CustomerNameRecord[]): string | null {
  if (!email) return null;
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
export async function hasRealPurchase(email: string): Promise<boolean> {
  if (!isStudioDbAvailable()) return false;
  return hasEverPaid(memberIdFromEmail(email.trim()));
}

/**
 * Pure — no I/O. Best fuzzy match of `name` against `customers`, above
 * FUZZY_MATCH_THRESHOLD, or null if nothing clears the bar. Exported for
 * unit testing without a database call.
 */
export function findBestNameMatch(
  name: string,
  customers: CustomerNameRecord[],
): FuzzyMatch | null {
  let best: FuzzyMatch | null = null;
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
export async function checkExistingCustomer(
  email: string | null,
  name: string,
  customers: CustomerNameRecord[],
): Promise<PurchaseCheckResult> {
  if (email) {
    const purchased = await hasRealPurchase(email);
    if (purchased) {
      return { isExistingCustomer: true, fuzzyMatch: null };
    }
  }
  return { isExistingCustomer: false, fuzzyMatch: findBestNameMatch(name, customers) };
}
