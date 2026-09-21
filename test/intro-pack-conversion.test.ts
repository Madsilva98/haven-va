import { describe, expect, it } from "vitest";

import {
  describePostExpiryVisit,
  isExpiringPackToWatch,
  selectFirstTrackedPacks,
} from "../src/lib/intro-pack-conversion.js";
import { memberIdFromEmail, type IntroPurchaseRow } from "../src/lib/pulse-views.js";

function purchase(
  email: string,
  pack: string,
  intro_purchase: string,
  intro_end: string,
  over: Partial<IntroPurchaseRow> = {},
): IntroPurchaseRow {
  return {
    sale_id: 1,
    email,
    member_id: memberIdFromEmail(email),
    item_name: `${pack} item`,
    pack,
    intro_purchase,
    kenko_start: intro_purchase,
    intro_end,
    intro_end_source: "kenko",
    is_open_day: false,
    is_valentine: false,
    is_for_members: false,
    visits_in_pack: 0,
    is_activated: true,
    kenko_status: "Expired",
    ...over,
  };
}

describe("selectFirstTrackedPacks", () => {
  const customers = [{ name: "Sofia Orellana", email: "s@x.com", phone: "+351" }];

  it("keeps only 2-Class and 10-Day packs, first purchase per person, with the view's real expiry", () => {
    const out = selectFirstTrackedPacks(
      [
        purchase("s@x.com", "10-Day", "2026-09-20", "2026-09-30"), // later, must not win
        purchase("s@x.com", "2-Class", "2026-08-27", "2026-09-14"),
        purchase("o@x.com", "5-Class", "2026-08-01", "2026-08-22"),
      ],
      customers,
    );
    expect([...out.keys()]).toEqual(["s@x.com"]);
    expect(out.get("s@x.com")).toMatchObject({ name: "Sofia Orellana", pack: "2-Class", packName: "2-Class item" });
    // end of the intro_end day in Lisbon (WEST = UTC+1 in September)
    expect(out.get("s@x.com")!.expiresAt.toISOString()).toBe("2026-09-14T22:59:59.000Z");
  });

  it("skips Open Day / Valentine / for-members sales", () => {
    const rows = [
      purchase("a@x.com", "2-Class", "2026-08-01", "2026-08-22", { is_for_members: true }),
      purchase("b@x.com", "2-Class", "2026-08-01", "2026-08-22", { is_valentine: true }),
      purchase("c@x.com", "10-Day", "2026-08-01", "2026-08-11", { is_open_day: true }),
    ];
    expect(selectFirstTrackedPacks(rows, customers).size).toBe(0);
  });

  it("falls back to the email as the name when no identity row matches", () => {
    const out = selectFirstTrackedPacks([purchase("nobody@x.com", "10-Day", "2026-08-01", "2026-08-11")], customers);
    expect(out.get("nobody@x.com")?.name).toBe("nobody@x.com");
  });

  it("carries is_activated — a never-activated pack (false) or an unmatched sale (NULL) is not an ended pack (case #25)", () => {
    const out = selectFirstTrackedPacks(
      [
        purchase("k@x.com", "2-Class", "2026-08-01", "2026-08-22"),
        purchase("m@x.com", "10-Day", "2026-07-29", "2026-08-08", { is_activated: false, kenko_status: "Active", intro_end_source: "modeled", kenko_start: null }),
        purchase("n@x.com", "10-Day", "2026-07-29", "2026-08-08", { is_activated: null, kenko_status: null, intro_end_source: "modeled", kenko_start: null }),
      ],
      customers,
    );
    expect(out.get("k@x.com")?.activated).toBe(true);
    expect(out.get("m@x.com")?.activated).toBe(false);
    expect(out.get("n@x.com")?.activated).toBe(false);
  });

  it("lower-cases the email key", () => {
    const out = selectFirstTrackedPacks([purchase("Mixed@X.com", "10-Day", "2026-08-01", "2026-08-11")], customers);
    expect([...out.keys()]).toEqual(["mixed@x.com"]);
  });
});

describe("describePostExpiryVisit", () => {
  const expiresAt = new Date("2026-07-16T22:59:00Z");

  it("returns a note when the last visit is after the pack's expiry — Liza Kupriievych case", () => {
    const note = describePostExpiryVisit({ expiresAt, lastVisit: new Date("2026-08-25T19:30:00Z") });
    expect(note).toContain("voltou depois disso");
    expect(note).toContain("25/08/2026");
  });

  it("returns null when there was no visit at all", () => {
    expect(describePostExpiryVisit({ expiresAt, lastVisit: null })).toBeNull();
  });

  it("returns null when the last visit is before the pack's expiry", () => {
    expect(describePostExpiryVisit({ expiresAt, lastVisit: new Date("2026-07-10T00:00:00Z") })).toBeNull();
  });

  it("returns null when the last visit exactly equals the expiry instant", () => {
    expect(describePostExpiryVisit({ expiresAt, lastVisit: new Date(expiresAt) })).toBeNull();
  });
});

describe("isExpiringPackToWatch — founder's spec 2026-09-20, on visits_in_pack", () => {
  it("2-Class: exactly one class taken on the pack", () => {
    expect(isExpiringPackToWatch("2-Class", 1)).toBe(true);
    expect(isExpiringPackToWatch("2-Class", 0)).toBe(false);
    expect(isExpiringPackToWatch("2-Class", 2)).toBe(false);
  });

  it("10-Day: more than five classes taken on the pack", () => {
    expect(isExpiringPackToWatch("10-Day", 6)).toBe(true);
    expect(isExpiringPackToWatch("10-Day", 5)).toBe(false);
  });

  it("no other pack label qualifies", () => {
    expect(isExpiringPackToWatch("5-Class", 3)).toBe(false);
  });
});
