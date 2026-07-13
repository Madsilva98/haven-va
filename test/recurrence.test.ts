import { describe, expect, it } from "vitest";
import { isValidRecurrence, RECURRENCE_VALUES } from "../src/types.js";
import { nextOccurrence } from "../src/lib/recurrence.js";

describe("isValidRecurrence", () => {
  it.each(RECURRENCE_VALUES)("accepts known value %s", (value) => {
    expect(isValidRecurrence(value)).toBe(true);
  });

  it.each([
    "anual",
    "yearly",
    "DIÁRIA",
    "diaria",
    " diária ",
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
  // 2026-05-15 is a Friday. Times here are deliberately *naive* (no Z) — the
  // function preserves the same wall-clock convention as the existing code.
  const base = "2026-05-15T09:00:00";

  it("advances diária by 1 day", () => {
    expect(nextOccurrence(base, "diária")).toBe("2026-05-16T09:00:00");
  });

  it("advances semanal by 7 days", () => {
    expect(nextOccurrence(base, "semanal")).toBe("2026-05-22T09:00:00");
  });

  it("advances mensal by 1 month", () => {
    expect(nextOccurrence(base, "mensal")).toBe("2026-06-15T09:00:00");
  });

  it("rolls month boundary for diária", () => {
    expect(nextOccurrence("2026-05-31T08:00:00", "diária")).toBe(
      "2026-06-01T08:00:00",
    );
  });

  it("rolls year boundary for mensal", () => {
    expect(nextOccurrence("2026-12-15T08:00:00", "mensal")).toBe(
      "2027-01-15T08:00:00",
    );
  });

  it("throws on unknown recurrence rather than silently re-using the original date", () => {
    // Cast to bypass TS — this simulates a runtime value sneaking past the
    // type guard at the read site (e.g. someone adds a new option in the
    // Notion UI and the type cast in notion.ts doesn't validate).
    expect(() =>
      nextOccurrence(base, "anual" as unknown as Parameters<typeof nextOccurrence>[1]),
    ).toThrow(/unsupported recurrence/);
  });
});
