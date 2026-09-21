import { describe, expect, it } from "vitest";

import {
  computeChurnFlags,
  isExcludedEmail,
  parseMonthlyAllowance,
  type ActiveSubscriber,
  type BookingRecord,
  type FailedPaymentRecord,
  type PausedCycleWindow,
} from "../src/lib/churn-signals.js";

describe("isExcludedEmail", () => {
  it("excludes staff/test gmail plus-addressing", () => {
    expect(isExcludedEmail("madsilva3@gmail.com")).toBe(true);
    expect(isExcludedEmail("madsilva3+test12@gmail.com")).toBe(true);
  });

  it("excludes any @thehavenpilates.pt address", () => {
    expect(isExcludedEmail("beatriz@thehavenpilates.pt")).toBe(true);
  });

  it("excludes the two named staff emails", () => {
    expect(isExcludedEmail("oliveiraneuza1999@gmail.com")).toBe(true);
    expect(isExcludedEmail("santi.viquez@gmail.com")).toBe(true);
  });

  it("does not exclude a real customer email", () => {
    expect(isExcludedEmail("cliente.real@gmail.com")).toBe(false);
  });
});

describe("parseMonthlyAllowance", () => {
  it("parses the leading Nx pattern", () => {
    expect(parseMonthlyAllowance("4x Monthly | Premium")).toBe(4);
    expect(parseMonthlyAllowance("12x Monthly | Premium")).toBe(12);
  });

  it("returns null for Unlimited plans", () => {
    expect(parseMonthlyAllowance("Unlimited | Premium")).toBeNull();
  });
});

describe("computeChurnFlags", () => {
  const NOW = new Date("2026-09-16T12:00:00Z");

  function subscriber(email: string, membershipName: string, startsAt: string): ActiveSubscriber {
    return { email, name: email, membershipName, subscriptionStartsAt: new Date(startsAt) };
  }

  it("flags no booking in >14 days for a long-tenured subscriber", () => {
    const subs = [subscriber("a@x.com", "4x Monthly | Premium", "2026-01-01T00:00:00Z")];
    const bookings: BookingRecord[] = [
      { email: "a@x.com", bookingDate: new Date("2026-07-01T00:00:00Z"), eventDate: new Date("2026-07-01T00:00:00Z"), status: "Booked" },
    ];
    const flags = computeChurnFlags(subs, bookings, [], [], NOW);
    expect(flags).toHaveLength(1);
    expect(flags[0]!.signals.map((s) => s.type)).toContain("Sem reservas 14+ dias");
  });

  it("does not flag a brand-new subscriber (tenure < 14 days) with no booking yet", () => {
    const subs = [subscriber("new@x.com", "4x Monthly | Premium", "2026-09-10T00:00:00Z")];
    const flags = computeChurnFlags(subs, [], [], [], NOW);
    expect(flags).toHaveLength(0);
  });

  it("does not flag someone who booked recently and used their plan normally", () => {
    const subs = [subscriber("b@x.com", "4x Monthly | Premium", "2026-01-01T00:00:00Z")];
    // 2 of 4 credits/month (exactly 50%, not <50%) in each of the last 3
    // full months, plus a recent booking — neither signal should fire.
    const bookings: BookingRecord[] = [
      { email: "b@x.com", bookingDate: new Date("2026-06-05T00:00:00Z"), eventDate: new Date("2026-06-05T00:00:00Z"), status: "Booked" },
      { email: "b@x.com", bookingDate: new Date("2026-06-15T00:00:00Z"), eventDate: new Date("2026-06-15T00:00:00Z"), status: "Booked" },
      { email: "b@x.com", bookingDate: new Date("2026-07-05T00:00:00Z"), eventDate: new Date("2026-07-05T00:00:00Z"), status: "Booked" },
      { email: "b@x.com", bookingDate: new Date("2026-07-15T00:00:00Z"), eventDate: new Date("2026-07-15T00:00:00Z"), status: "Booked" },
      { email: "b@x.com", bookingDate: new Date("2026-08-05T00:00:00Z"), eventDate: new Date("2026-08-05T00:00:00Z"), status: "Booked" },
      { email: "b@x.com", bookingDate: new Date("2026-08-15T00:00:00Z"), eventDate: new Date("2026-08-15T00:00:00Z"), status: "Booked" },
      { email: "b@x.com", bookingDate: new Date("2026-09-14T00:00:00Z"), eventDate: new Date("2026-09-14T00:00:00Z"), status: "Booked" },
    ];
    const flags = computeChurnFlags(subs, bookings, [], [], NOW);
    expect(flags).toHaveLength(0);
  });

  it("flags a failed payment within the last 45 days", () => {
    const subs = [subscriber("c@x.com", "4x Monthly | Premium", "2026-09-01T00:00:00Z")];
    const bookings: BookingRecord[] = [
      { email: "c@x.com", bookingDate: new Date("2026-09-15T00:00:00Z"), eventDate: new Date("2026-09-15T00:00:00Z"), status: "Booked" },
    ];
    const failedPayments: FailedPaymentRecord[] = [
      { email: "c@x.com", paymentDate: new Date("2026-09-05T00:00:00Z") },
    ];
    const flags = computeChurnFlags(subs, bookings, failedPayments, [], NOW);
    expect(flags).toHaveLength(1);
    expect(flags[0]!.signals.map((s) => s.type)).toContain("Pagamento falhado");
  });

  it("ignores a failed payment older than 45 days", () => {
    const subs = [subscriber("d@x.com", "4x Monthly | Premium", "2026-01-01T00:00:00Z")];
    const bookings: BookingRecord[] = [
      { email: "d@x.com", bookingDate: new Date("2026-06-05T00:00:00Z"), eventDate: new Date("2026-06-05T00:00:00Z"), status: "Booked" },
      { email: "d@x.com", bookingDate: new Date("2026-06-15T00:00:00Z"), eventDate: new Date("2026-06-15T00:00:00Z"), status: "Booked" },
      { email: "d@x.com", bookingDate: new Date("2026-07-05T00:00:00Z"), eventDate: new Date("2026-07-05T00:00:00Z"), status: "Booked" },
      { email: "d@x.com", bookingDate: new Date("2026-07-15T00:00:00Z"), eventDate: new Date("2026-07-15T00:00:00Z"), status: "Booked" },
      { email: "d@x.com", bookingDate: new Date("2026-08-05T00:00:00Z"), eventDate: new Date("2026-08-05T00:00:00Z"), status: "Booked" },
      { email: "d@x.com", bookingDate: new Date("2026-08-15T00:00:00Z"), eventDate: new Date("2026-08-15T00:00:00Z"), status: "Booked" },
      { email: "d@x.com", bookingDate: new Date("2026-09-14T00:00:00Z"), eventDate: new Date("2026-09-14T00:00:00Z"), status: "Booked" },
    ];
    const failedPayments: FailedPaymentRecord[] = [
      { email: "d@x.com", paymentDate: new Date("2026-06-01T00:00:00Z") },
    ];
    const flags = computeChurnFlags(subs, bookings, failedPayments, [], NOW);
    expect(flags).toHaveLength(0);
  });

  it("flags <50% utilization in each of the last 3 full months for a long-tenured subscriber", () => {
    const subs = [subscriber("e@x.com", "4x Monthly | Premium", "2026-01-01T00:00:00Z")];
    // 1 booking/month in June, July, August (allowance 4) — well under 50%.
    // Also a recent booking so signal 1 doesn't also fire (isolates signal 3).
    const bookings: BookingRecord[] = [
      { email: "e@x.com", bookingDate: new Date("2026-06-10T00:00:00Z"), eventDate: new Date("2026-06-10T00:00:00Z"), status: "Booked" },
      { email: "e@x.com", bookingDate: new Date("2026-07-10T00:00:00Z"), eventDate: new Date("2026-07-10T00:00:00Z"), status: "Booked" },
      { email: "e@x.com", bookingDate: new Date("2026-08-10T00:00:00Z"), eventDate: new Date("2026-08-10T00:00:00Z"), status: "Booked" },
      { email: "e@x.com", bookingDate: new Date("2026-09-14T00:00:00Z"), eventDate: new Date("2026-09-14T00:00:00Z"), status: "Booked" },
    ];
    const flags = computeChurnFlags(subs, bookings, [], [], NOW);
    expect(flags).toHaveLength(1);
    expect(flags[0]!.signals.map((s) => s.type)).toEqual(["Baixa utilização"]);
  });

  it("does not flag utilization for a subscriber who wasn't a member for the whole window (the found-and-fixed bug)", () => {
    // Joined 10 days ago — must not count June/July/August as "0 bookings = underuse".
    const subs = [subscriber("f@x.com", "4x Monthly | Premium", "2026-09-06T00:00:00Z")];
    const flags = computeChurnFlags(subs, [], [], [], NOW);
    expect(flags).toHaveLength(0);
  });

  it("excludes months that overlap a paused/stretched billing cycle from the utilization check (Raquel Saraiva case)", () => {
    // Real case: paused 27/05-15/07, and kenko_memberships records this as
    // one 80-day cycle (26/04-15/07) since kenko_subscriptions itself keeps
    // her original signup date throughout, unaffected by the pause. That
    // cycle overlaps both June AND the first half of July, so both get
    // excluded — leaving only August, which alone can't satisfy "all 3
    // months <50%", so the signal correctly can't fire either way (not
    // enough clean months yet, rather than wrongly reading 0%/0%/13%).
    // A recent booking keeps signal 1 from firing too, isolating signal 3.
    const subs = [subscriber("k@x.com", "8x Monthly | Premium", "2025-12-18T00:00:00Z")];
    const bookings: BookingRecord[] = [
      { email: "k@x.com", bookingDate: new Date("2026-08-20T00:00:00Z"), eventDate: new Date("2026-08-20T00:00:00Z"), status: "Booked" },
      { email: "k@x.com", bookingDate: new Date("2026-09-10T00:00:00Z"), eventDate: new Date("2026-09-10T00:00:00Z"), status: "Booked" },
    ];
    const pausedCycles: PausedCycleWindow[] = [
      { email: "k@x.com", start: new Date("2026-04-26T00:00:00Z"), end: new Date("2026-07-15T00:00:00Z") }, // 80-day stretched cycle
    ];
    const flags = computeChurnFlags(subs, bookings, [], pausedCycles, NOW);
    expect(flags).toHaveLength(0);
  });

  it("still flags genuine low utilization when a paused cycle doesn't overlap the evaluated months", () => {
    const subs = [subscriber("l@x.com", "4x Monthly | Premium", "2026-01-01T00:00:00Z")];
    const pausedCycles: PausedCycleWindow[] = [
      // Stretched, but back in Feb-Mar — doesn't touch June/July/August.
      { email: "l@x.com", start: new Date("2026-02-01T00:00:00Z"), end: new Date("2026-03-25T00:00:00Z") },
    ];
    const bookings: BookingRecord[] = [
      { email: "l@x.com", bookingDate: new Date("2026-09-14T00:00:00Z"), eventDate: new Date("2026-09-14T00:00:00Z"), status: "Booked" },
    ];
    const flags = computeChurnFlags(subs, bookings, [], pausedCycles, NOW);
    expect(flags).toHaveLength(1);
    expect(flags[0]!.signals.map((s) => s.type)).toEqual(["Baixa utilização"]);
  });

  it("does not treat a normal ~30-day cycle as a pause", () => {
    const subs = [subscriber("m@x.com", "4x Monthly | Premium", "2026-01-01T00:00:00Z")];
    const pausedCycles: PausedCycleWindow[] = [
      { email: "m@x.com", start: new Date("2026-08-01T00:00:00Z"), end: new Date("2026-08-31T00:00:00Z") }, // 30 days, normal
    ];
    // A recent booking isolates signal 3 (matches this file's other signal-3
    // tests) — it falls in September, outside the 3 evaluated months, so it
    // doesn't affect the June/July/August ratios themselves.
    const bookings: BookingRecord[] = [
      { email: "m@x.com", bookingDate: new Date("2026-09-14T00:00:00Z"), eventDate: new Date("2026-09-14T00:00:00Z"), status: "Booked" },
    ];
    const flags = computeChurnFlags(subs, bookings, [], pausedCycles, NOW);
    expect(flags).toHaveLength(1); // still flags — 0 bookings in June/July/August, all genuinely unused
    expect(flags[0]!.signals.map((s) => s.type)).toEqual(["Baixa utilização"]);
  });

  it("does not evaluate signal 3 for Unlimited plans", () => {
    const subs = [subscriber("g@x.com", "Unlimited | Premium", "2026-01-01T00:00:00Z")];
    const bookings: BookingRecord[] = [
      { email: "g@x.com", bookingDate: new Date("2026-09-14T00:00:00Z"), eventDate: new Date("2026-09-14T00:00:00Z"), status: "Booked" },
    ];
    const flags = computeChurnFlags(subs, bookings, [], [], NOW);
    expect(flags).toHaveLength(0);
  });

  it("dedupes multiple subscription rows for the same person to the most recent", () => {
    const subs = [
      subscriber("h@x.com", "4x Monthly | Premium", "2026-01-01T00:00:00Z"),
      subscriber("h@x.com", "8x Monthly | Premium", "2026-08-01T00:00:00Z"),
    ];
    const bookings: BookingRecord[] = [
      { email: "h@x.com", bookingDate: new Date("2026-09-14T00:00:00Z"), eventDate: new Date("2026-09-14T00:00:00Z"), status: "Booked" },
    ];
    const flags = computeChurnFlags(subs, bookings, [], [], NOW);
    expect(flags).toHaveLength(0);
  });

  it("ignores a booking from before the current active stretch (e.g. before resuming from a pause) as the last booking", () => {
    // Pausing/resuming creates a new subscription row with its own start
    // date — a booking from the stretch before pausing must not count as
    // "last booking" once someone's back, or the reported gap would cite a
    // stale pre-pause date and overstate how long they've been away.
    const subs = [subscriber("i@x.com", "4x Monthly | Premium", "2026-09-01T00:00:00Z")]; // resumed 15 days ago
    const bookings: BookingRecord[] = [
      { email: "i@x.com", bookingDate: new Date("2026-06-01T00:00:00Z"), eventDate: new Date("2026-06-01T00:00:00Z"), status: "Booked" },
    ];
    const flags = computeChurnFlags(subs, bookings, [], [], NOW);
    expect(flags).toHaveLength(1);
    const detail = flags[0]!.signals.find((s) => s.type === "Sem reservas 14+ dias")!.detail;
    expect(detail).toContain("nenhuma reserva desde a inscrição");
    expect(detail).not.toContain("01/06/2026");
  });

  it("does not let a since-cancelled booking reset the no-booking gap", () => {
    // A recent booking that was later cancelled must not make someone look
    // engaged — only a still-valid "Booked" reservation counts.
    const subs = [subscriber("j@x.com", "4x Monthly | Premium", "2026-01-01T00:00:00Z")];
    const bookings: BookingRecord[] = [
      { email: "j@x.com", bookingDate: new Date("2026-07-01T00:00:00Z"), eventDate: new Date("2026-07-01T00:00:00Z"), status: "Booked" },
      { email: "j@x.com", bookingDate: new Date("2026-09-14T00:00:00Z"), eventDate: new Date("2026-09-20T00:00:00Z"), status: "Canceled" },
    ];
    const flags = computeChurnFlags(subs, bookings, [], [], NOW);
    expect(flags).toHaveLength(1);
    const detail = flags[0]!.signals.find((s) => s.type === "Sem reservas 14+ dias")!.detail;
    expect(detail).toContain("01/07/2026"); // cites the real last Booked reservation, not the cancelled one
  });

  it("excludes staff/test accounts even if they'd otherwise be flagged", () => {
    const subs = [subscriber("madsilva3+test1@gmail.com", "4x Monthly | Premium", "2026-01-01T00:00:00Z")];
    const flags = computeChurnFlags(subs, [], [], [], NOW);
    expect(flags).toHaveLength(0);
  });
});
