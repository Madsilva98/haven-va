import { describe, expect, it } from "vitest";

import { hasConvertedAfter } from "../src/lib/intro-pack-conversion.js";

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
