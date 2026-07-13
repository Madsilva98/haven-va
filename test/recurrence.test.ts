import { describe, expect, it } from "vitest";
import { isValidRecurrence, RECURRENCE_VALUES } from "../src/types.js";
import { nextOccurrence } from "../src/lib/recurrence.js";

describe("isValidRecurrence", () => {
  it.each(RECURRENCE_VALUES)("accepts known value %s", (value) => {
    expect(isValidRecurrence(value)).toBe(true);
  });

  it.each([
    "yearly",
    "annually",
    "DIÁRIA",
    "diaria",
    " diária ",
    "a cada 2 semanas",
    "",
    null,
    undefined,
    42,
    {},
  ])("rejects unknown value %p", (value) => {
    expect(isValidRecurrence(value)).toBe(false);
  });
});

describe("nextOccurrence", () => {
  // Inputs are absolute UTC instants (…Z), matching how Quando is stored in
  // Notion after the DST fix. nextOccurrence advances the instant in UTC and
  // returns a UTC ISO string — no local-time relabeling, so these assertions
  // are timezone-independent.
  const base = "2026-05-15T09:00:00.000Z";

  it("advances diária by 1 day", () => {
    expect(nextOccurrence(base, "diária")).toBe("2026-05-16T09:00:00.000Z");
  });

  it("advances semanal by 7 days", () => {
    expect(nextOccurrence(base, "semanal")).toBe("2026-05-22T09:00:00.000Z");
  });

  it("advances mensal by 1 month", () => {
    expect(nextOccurrence(base, "mensal")).toBe("2026-06-15T09:00:00.000Z");
  });

  it("advances anual by 1 year (birthday/anniversary)", () => {
    expect(nextOccurrence(base, "anual")).toBe("2027-05-15T09:00:00.000Z");
  });

  it("rolls month boundary for diária", () => {
    expect(nextOccurrence("2026-05-31T08:00:00.000Z", "diária")).toBe(
      "2026-06-01T08:00:00.000Z",
    );
  });

  it("rolls year boundary for mensal", () => {
    expect(nextOccurrence("2026-12-15T08:00:00.000Z", "mensal")).toBe(
      "2027-01-15T08:00:00.000Z",
    );
  });

  it("anual: handles Feb-29 leap-year birthday by rolling to Mar-1", () => {
    // 2028 is a leap year; 2029 is not. A Feb-29 birthday set in 2028
    // should produce Mar-1 in 2029 — better to send one day late than
    // skip the year. JS Date semantics handle this automatically via
    // setUTCFullYear.
    expect(nextOccurrence("2028-02-29T09:00:00.000Z", "anual")).toBe(
      "2029-03-01T09:00:00.000Z",
    );
  });

  it("anual: normal date stays on same month/day across years", () => {
    expect(nextOccurrence("2026-03-15T10:30:00.000Z", "anual")).toBe(
      "2027-03-15T10:30:00.000Z",
    );
  });

  it("throws on unknown recurrence rather than silently re-using the original date", () => {
    // Cast to bypass TS — this simulates a runtime value sneaking past the
    // type guard at the read site (e.g. someone adds a new option in the
    // Notion UI and the cast in notion.ts doesn't validate).
    expect(() =>
      nextOccurrence(base, "yearly" as unknown as Parameters<typeof nextOccurrence>[1]),
    ).toThrow(/unsupported recurrence/);
  });
});
