import { describe, expect, it } from "vitest";

import { describePostExpiryVisit, hasConvertedAfter } from "../src/lib/intro-pack-conversion.js";

describe("hasConvertedAfter", () => {
  const after = new Date("2026-06-01T00:00:00Z");

  it("is true when a later subscription exists", () => {
    const subsByEmail = new Map([["a@x.com", [new Date("2026-06-15T00:00:00Z")]]]);
    expect(hasConvertedAfter("a@x.com", after, subsByEmail, new Map())).toBe(true);
  });

  it("is true when a later non-intro membership exists", () => {
    const membershipsByEmail = new Map([["b@x.com", [new Date("2026-07-01T00:00:00Z")]]]);
    expect(hasConvertedAfter("b@x.com", after, new Map(), membershipsByEmail)).toBe(true);
  });

  it("is false when the only subscription is before the cutoff", () => {
    const subsByEmail = new Map([["c@x.com", [new Date("2026-05-01T00:00:00Z")]]]);
    expect(hasConvertedAfter("c@x.com", after, subsByEmail, new Map())).toBe(false);
  });

  it("is false when the person has no history at all", () => {
    expect(hasConvertedAfter("nobody@x.com", after, new Map(), new Map())).toBe(false);
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
