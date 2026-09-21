import { describe, expect, it } from "vitest";

import { activeMemberIdsForBirthdays, filterUpcomingBirthdays } from "../src/lib/birthdays.js";
import { formatBirthdayDigest } from "../src/messages/birthdays.js";

function customer(name: string, email: string, dob: string | null) {
  return { contact_name: name, contact_email: email, date_of_birth: dob };
}

describe("filterUpcomingBirthdays", () => {
  // Anchor on a Friday 2026-05-15 for all tests.
  const REF = new Date(2026, 4, 15); // May = 4 (0-indexed)

  it("matches today's birthday with daysUntil=0", () => {
    const out = filterUpcomingBirthdays(
      [customer("Joana Silva", "j@x.com", "1985-05-15")],
      REF,
      7,
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.daysUntil).toBe(0);
    expect(out[0]!.name).toBe("Joana Silva");
  });

  it("matches birthday 3 days from now", () => {
    const out = filterUpcomingBirthdays(
      [customer("Maria Santos", "m@x.com", "1990-05-18")],
      REF,
      7,
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.daysUntil).toBe(3);
  });

  it("excludes birthday outside the daysAhead window", () => {
    const out = filterUpcomingBirthdays(
      [customer("Pedro", "p@x.com", "1980-05-25")], // 10 days away
      REF,
      7,
    );
    expect(out).toHaveLength(0);
  });

  it("ignores rows without DOB", () => {
    const out = filterUpcomingBirthdays(
      [customer("No DOB", "n@x.com", null)],
      REF,
      7,
    );
    expect(out).toHaveLength(0);
  });

  it("year-agnostic: matches 1985 DOB against 2026 reference", () => {
    const out = filterUpcomingBirthdays(
      [customer("Old Customer", "o@x.com", "1970-05-15")],
      REF,
      7,
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.daysUntil).toBe(0);
  });

  it("handles month-end window crossing into next month", () => {
    // Ref is 2026-05-28, window 5 days → should include June 1
    const monthEnd = new Date(2026, 4, 28);
    const out = filterUpcomingBirthdays(
      [
        customer("End May", "a@x.com", "1985-05-30"),
        customer("Early June", "b@x.com", "1985-06-01"),
        customer("Mid June", "c@x.com", "1985-06-10"),
      ],
      monthEnd,
      5,
    );
    expect(out.map((b) => b.name)).toEqual(["End May", "Early June"]);
    expect(out.find((b) => b.name === "End May")!.daysUntil).toBe(2);
    expect(out.find((b) => b.name === "Early June")!.daysUntil).toBe(4);
  });

  it("handles year-end window crossing into next year", () => {
    const yearEnd = new Date(2026, 11, 29); // Dec 29
    const out = filterUpcomingBirthdays(
      [
        customer("New Year", "a@x.com", "1985-01-02"),
        customer("Dec 30", "b@x.com", "1985-12-30"),
      ],
      yearEnd,
      7,
    );
    expect(out.map((b) => b.name)).toEqual(["Dec 30", "New Year"]);
  });

  it("sorts results by daysUntil, then name alphabetically", () => {
    const out = filterUpcomingBirthdays(
      [
        customer("Zé", "z@x.com", "1985-05-17"),
        customer("Ana", "a@x.com", "1985-05-17"),
        customer("Bruno", "b@x.com", "1985-05-15"),
      ],
      REF,
      7,
    );
    expect(out.map((b) => b.name)).toEqual(["Bruno", "Ana", "Zé"]);
  });

  it("falls back to email when contact_name is null", () => {
    const out = filterUpcomingBirthdays(
      [customer("", "no-name@x.com", "1985-05-15")],
      REF,
      7,
    );
    expect(out[0]!.name).toBe("no-name@x.com");
  });

  it("rejects malformed date_of_birth", () => {
    const out = filterUpcomingBirthdays(
      [customer("Bad", "b@x.com", "not-a-date")],
      REF,
      7,
    );
    expect(out).toHaveLength(0);
  });
});

describe("formatBirthdayDigest", () => {
  it("returns null when empty (no message to send)", () => {
    expect(formatBirthdayDigest([])).toBeNull();
  });

  it("lists everyone with a birthday today", () => {
    const out = formatBirthdayDigest([
      { name: "Joana", email: "j@x.com", dateOfBirth: "1985-05-15", daysUntil: 0 },
    ]);
    expect(out).toContain("🎂 *Hoje é aniversário de:*");
    expect(out).toContain("• Joana");
  });

  it("lists multiple same-day birthdays, one per line", () => {
    const out = formatBirthdayDigest([
      { name: "Joana", email: "j@x.com", dateOfBirth: "1985-05-15", daysUntil: 0 },
      { name: "Bruno", email: "b@x.com", dateOfBirth: "1990-05-15", daysUntil: 0 },
    ]);
    expect(out).toContain("• Joana");
    expect(out).toContain("• Bruno");
  });
});

describe("activeMemberIdsForBirthdays", () => {
  it("unions paying members, live class packs with credits, and live intro holders — as of the data date", () => {
    const ids = activeMemberIdsForBirthdays(
      new Map([
        ["m1", { memberId: "m1", tier: "4x", plan: "Premium", membershipName: "4x Monthly | Premium", memberSince: "2026-01-01" }],
      ]),
      [
        { member_id: "p1", started: "2026-09-01", expires: "2026-12-01", has_credits: true },
        { member_id: "p2", started: "2026-09-01", expires: "2026-12-01", has_credits: false }, // used up
        { member_id: "p3", started: "2026-01-01", expires: "2026-02-01", has_credits: true }, // expired
      ],
      [
        { member_id: "i1", started: "2026-09-10", expires: "2026-09-30" },
        { member_id: "i2", started: "2026-08-01", expires: "2026-08-22" }, // expired
      ],
      "2026-09-18",
    );
    expect([...ids].sort()).toEqual(["i1", "m1", "p1"]);
  });
});
