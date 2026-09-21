/**
 * Churn-risk signal computation for src/crons/churn-risk.ts.
 *
 * Three signals were empirically validated against real Studio Supabase
 * data (staff/test accounts and people who "cancelled" but reactivated
 * under another subscription/pack excluded first — see docs/knowledge-base
 * for the session that derived these):
 *
 * 1. No booking in >14 days on a subscription that's still Active (only
 *    once the subscription itself is >=14 days old, so brand-new signups
 *    aren't flagged before they've had a first class). Originally set to
 *    21 days (39.6% of real cancellations vs. 7.0% of active members had
 *    that gap); re-derived 2026-09-16 at the founder's request ("21 dias
 *    é já muito, quase um mês sem aproveitar") by testing a range of
 *    thresholds against the same churned-vs-active comparison — 14 days
 *    gave the best separation of any candidate tested (54.2% of
 *    cancellations vs. 20.0% of active members, a wider gap than 21 days'
 *    40.4% vs 10.0%), not just a shorter one. Trade-off: roughly 1 in 5
 *    currently-active members will show this gap at some point (vs. 1 in
 *    10 at 21 days) — more coverage, more noise. See
 *    docs/knowledge-base for the full table across 7/10/14/17/21/24/28/30
 *    days if this ever needs re-deriving again.
 * 2. A failed payment in the last 45 days on a still-Active subscription.
 * 3. Utilization under 50% of the plan's monthly credit allowance in EACH
 *    of the last 3 full calendar months — a month only counts if the
 *    subscription already existed for the whole month (otherwise a brand
 *    new member's pre-signup months get counted as "0 bookings = underuse",
 *    a real bug found and fixed while validating this).
 *
 * Explicitly tested and rejected (do not resurrect without re-validating):
 * raw unused-credits snapshot, no-show rate, "never booked at all" — none
 * discriminated churned vs. active members once the above noise was removed.
 */

import type { ChurnSignalType } from "../types.js";
import { fetchAllCustomerNames, findPhoneByEmail } from "./leads.js";
import { log } from "./log.js";
import { fetchAllPages, studioSupabase } from "./studio-supabase.js";

// Staff/test accounts — not secrets, rarely change, kept here (not .env)
// so they're easy to find and extend.
const STAFF_TEST_EXACT_EMAILS = new Set([
  "oliveiraneuza1999@gmail.com",
  "santi.viquez@gmail.com",
]);
const STAFF_TEST_EMAIL_PATTERNS = [/^madsilva3(\+[^@]*)?@gmail\.com$/i, /@thehavenpilates\.pt$/i];

export function isExcludedEmail(email: string): boolean {
  const e = email.toLowerCase().trim();
  if (STAFF_TEST_EXACT_EMAILS.has(e)) return true;
  return STAFF_TEST_EMAIL_PATTERNS.some((re) => re.test(e));
}

/** "4x Monthly | Premium" -> 4. "Unlimited | Premium" -> null (not evaluated for signal 3). */
export function parseMonthlyAllowance(membershipName: string): number | null {
  const m = membershipName.match(/^(\d+)x/i);
  return m ? Number(m[1]) : null;
}

const NO_BOOKING_GAP_DAYS = 14;
const FAILED_PAYMENT_WINDOW_DAYS = 45;
const UNDERUSE_RATIO = 0.5;
const UNDERUSE_MONTHS = 3;

export interface ActiveSubscriber {
  email: string;
  name: string;
  membershipName: string;
  subscriptionStartsAt: Date;
}

export interface BookingRecord {
  email: string;
  bookingDate: Date;
  eventDate: Date;
  status: string;
}

export interface FailedPaymentRecord {
  email: string;
  paymentDate: Date;
}

export interface ChurnFlag {
  email: string;
  name: string;
  plano: string;
  telefone: string | null; // filled in by fetchChurnFlags (I/O); null from computeChurnFlags alone
  signals: { type: ChurnSignalType; detail: string }[];
}

function formatDatePt(d: Date): string {
  return d.toLocaleDateString("pt-PT", { timeZone: "Europe/Lisbon" });
}

function monthLabelPt(d: Date): string {
  return d.toLocaleDateString("pt-PT", { timeZone: "Europe/Lisbon", month: "short" });
}

export function dedupeLatestPerEmail(subscribers: ActiveSubscriber[]): Map<string, ActiveSubscriber> {
  const byEmail = new Map<string, ActiveSubscriber>();
  for (const s of subscribers) {
    const email = s.email.toLowerCase().trim();
    if (!email || isExcludedEmail(email)) continue;
    const existing = byEmail.get(email);
    if (!existing || s.subscriptionStartsAt > existing.subscriptionStartsAt) {
      byEmail.set(email, { ...s, email });
    }
  }
  return byEmail;
}

/**
 * Full calendar months preceding `now`, most recent first, excluding the
 * current (incomplete) month. Running on 2026-09-16 with monthsBack=3
 * yields [August, July, June] (2026).
 */
function fullCalendarMonthsBefore(now: Date, monthsBack: number): { start: Date; end: Date }[] {
  const months: { start: Date; end: Date }[] = [];
  const currentMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  for (let i = 1; i <= monthsBack; i++) {
    const start = new Date(Date.UTC(currentMonthStart.getUTCFullYear(), currentMonthStart.getUTCMonth() - i, 1));
    const end = new Date(Date.UTC(currentMonthStart.getUTCFullYear(), currentMonthStart.getUTCMonth() - i + 1, 1));
    months.push({ start, end });
  }
  return months;
}

/**
 * Pure — no I/O. Applies the three validated signals to already-fetched
 * Supabase rows. `now` is injectable for tests.
 */
export function computeChurnFlags(
  subscribers: ActiveSubscriber[],
  bookings: BookingRecord[],
  failedPayments: FailedPaymentRecord[],
  now: Date,
): ChurnFlag[] {
  const activeByEmail = dedupeLatestPerEmail(subscribers);

  const bookingsByEmail = new Map<string, BookingRecord[]>();
  for (const b of bookings) {
    const email = b.email.toLowerCase().trim();
    if (!activeByEmail.has(email)) continue;
    const list = bookingsByEmail.get(email) ?? [];
    list.push(b);
    bookingsByEmail.set(email, list);
  }

  const failedByEmail = new Map<string, FailedPaymentRecord[]>();
  for (const p of failedPayments) {
    const email = p.email.toLowerCase().trim();
    if (!activeByEmail.has(email)) continue;
    const list = failedByEmail.get(email) ?? [];
    list.push(p);
    failedByEmail.set(email, list);
  }

  const nowMs = now.getTime();
  const flags: ChurnFlag[] = [];

  for (const [email, sub] of activeByEmail) {
    const signals: ChurnFlag["signals"] = [];
    const subBookings = bookingsByEmail.get(email) ?? [];

    // Signal 1 — no booking in >21 days, subscription itself old enough to judge.
    const tenureDays = (nowMs - sub.subscriptionStartsAt.getTime()) / 86_400_000;
    if (tenureDays >= NO_BOOKING_GAP_DAYS) {
      const bookingsBeforeNow = subBookings.filter((b) => b.bookingDate.getTime() <= nowMs);
      const lastBooking = bookingsBeforeNow.reduce<Date | null>(
        (latest, b) => (!latest || b.bookingDate > latest ? b.bookingDate : latest),
        null,
      );
      const gapDays = lastBooking
        ? (nowMs - lastBooking.getTime()) / 86_400_000
        : tenureDays; // never booked at all since signup — treat as a full gap
      if (gapDays > NO_BOOKING_GAP_DAYS) {
        const detail = lastBooking
          ? `${Math.round(gapDays)} dias sem reservar (última reserva: ${formatDatePt(lastBooking)})`
          : `${Math.round(gapDays)} dias sem nenhuma reserva desde a inscrição`;
        signals.push({ type: "Sem reservas 14+ dias", detail });
      }
    }

    // Signal 2 — failed payment in the last 45 days.
    const recentFailed = (failedByEmail.get(email) ?? [])
      .filter((p) => nowMs - p.paymentDate.getTime() <= FAILED_PAYMENT_WINDOW_DAYS * 86_400_000)
      .sort((a, b) => b.paymentDate.getTime() - a.paymentDate.getTime())[0];
    if (recentFailed) {
      signals.push({
        type: "Pagamento falhado",
        detail: `pagamento falhado a ${formatDatePt(recentFailed.paymentDate)}`,
      });
    }

    // Signal 3 — <50% plan utilization in each of the last 3 full calendar months.
    const allowance = parseMonthlyAllowance(sub.membershipName);
    if (allowance !== null) {
      const months = fullCalendarMonthsBefore(now, UNDERUSE_MONTHS);
      const monthStats = months.map(({ start, end }) => {
        if (sub.subscriptionStartsAt > start) return null; // not a member for the whole month
        const count = subBookings.filter(
          (b) => b.status === "Booked" && b.eventDate >= start && b.eventDate < end,
        ).length;
        return { start, count, ratio: count / allowance };
      });
      const allValid = monthStats.every((m) => m !== null);
      if (allValid && monthStats.every((m) => m!.ratio < UNDERUSE_RATIO)) {
        const parts = monthStats
          .map((m) => m!)
          .reverse()
          .map((m) => `${monthLabelPt(m.start)}: ${Math.round(m.ratio * 100)}%`);
        const avgPct = Math.round(
          (monthStats.reduce((sum, m) => sum + m!.ratio, 0) / monthStats.length) * 100,
        );
        signals.push({
          type: "Baixa utilização",
          detail: `${avgPct}% de utilização média nos últimos ${UNDERUSE_MONTHS} meses (${parts.join(", ")})`,
        });
      }
    }

    if (signals.length > 0) {
      flags.push({ email, name: sub.name, plano: sub.membershipName, telefone: null, signals });
    }
  }

  return flags;
}

/**
 * Fetches the raw Supabase rows and computes flags. Also returns every
 * email currently on an Active subscription (regardless of whether they're
 * flagged) — src/crons/churn-risk.ts uses this to tell "still active, just
 * no current signal" (update the row, founder decides what to do) apart
 * from "no longer an active subscriber at all" (cancelled/deactivated —
 * safe to auto-archive, nothing left to watch).
 *
 * Returns empty (and logs a warn) if Studio Supabase isn't configured —
 * same graceful no-op as src/lib/birthdays.ts.
 */
export async function fetchChurnFlags(
  now: Date = new Date(),
): Promise<{ flags: ChurnFlag[]; activeEmails: Set<string> }> {
  if (!studioSupabase) {
    log.warn("churn_signals.fetch_skipped", { reason: "studio_supabase_not_configured" });
    return { flags: [], activeEmails: new Set() };
  }

  const fourMonthsAgoIso = new Date(now.getTime() - 4 * 30 * 86_400_000).toISOString();
  const fortyFiveDaysAgoIso = new Date(now.getTime() - FAILED_PAYMENT_WINDOW_DAYS * 86_400_000).toISOString();

  const [subsRows, bookingRows, failedRows] = await Promise.all([
    fetchAllPages<{
      contact_email: string | null;
      contact_name: string | null;
      membership_name: string | null;
      subscription_starts_at: string | null;
    }>((from, to) =>
      studioSupabase!
        .from("kenko_subscriptions")
        .select("contact_email, contact_name, membership_name, subscription_starts_at")
        .eq("subscription_status", "Active")
        .range(from, to),
    ),
    fetchAllPages<{
      contact_email: string | null;
      booking_date: string | null;
      event_date: string | null;
      booking_status: string | null;
    }>((from, to) =>
      studioSupabase!
        .from("kenko_bookings")
        .select("contact_email, booking_date, event_date, booking_status")
        .gte("booking_date", fourMonthsAgoIso)
        .range(from, to),
    ),
    fetchAllPages<{ contact_email: string | null; payment_date: string | null }>((from, to) =>
      studioSupabase!
        .from("kenko_payments")
        .select("contact_email, payment_date")
        .eq("payment_status", "Failed")
        .gte("payment_date", fortyFiveDaysAgoIso)
        .range(from, to),
    ),
  ]);

  const subscribers: ActiveSubscriber[] = subsRows
    .filter((r) => r.contact_email && r.membership_name && r.subscription_starts_at)
    .map((r) => ({
      email: r.contact_email!,
      name: r.contact_name || r.contact_email!,
      membershipName: r.membership_name!,
      subscriptionStartsAt: new Date(r.subscription_starts_at!),
    }));

  const bookings: BookingRecord[] = bookingRows
    .filter((r) => r.contact_email && r.booking_date && r.event_date)
    .map((r) => ({
      email: r.contact_email!,
      bookingDate: new Date(r.booking_date!),
      eventDate: new Date(r.event_date!),
      status: r.booking_status ?? "",
    }));

  const failedPayments: FailedPaymentRecord[] = failedRows
    .filter((r) => r.contact_email && r.payment_date)
    .map((r) => ({
      email: r.contact_email!,
      paymentDate: new Date(r.payment_date!),
    }));

  const flags = computeChurnFlags(subscribers, bookings, failedPayments, now);
  const activeEmails = new Set(dedupeLatestPerEmail(subscribers).keys());

  // Phone isn't in kenko_subscriptions — look it up from kenko_customers
  // (which includes Leads alongside real customers, so this can hit even
  // for edge cases where a phone was entered without a formal purchase).
  const customers = await fetchAllCustomerNames();
  for (const flag of flags) {
    flag.telefone = findPhoneByEmail(flag.email, customers);
  }

  log.debug("churn_signals.computed", {
    subscribers: subscribers.length,
    flagged: flags.length,
  });
  return { flags, activeEmails };
}
