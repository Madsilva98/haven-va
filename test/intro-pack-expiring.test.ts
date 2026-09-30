import { describe, expect, it } from "vitest";

import type { ExpiringIntroPackToWatch } from "../src/lib/intro-pack-conversion.js";
import { formatExpiringIntroPacksDigest } from "../src/messages/intro-pack-expiring.js";

function pack(overrides: Partial<ExpiringIntroPackToWatch>): ExpiringIntroPackToWatch {
  return {
    email: "x@x.com",
    name: "Someone",
    phone: null,
    pack: "2-Class",
    packName: "2 Classes | Premium",
    expiresAt: new Date("2026-09-22T22:59:00Z"),
    visitCount: 1,
    reason: "unused_ending",
    firstVisitOn: null,
    lastVisitOn: null,
    ...overrides,
  };
}

describe("formatExpiringIntroPacksDigest", () => {
  it("returns null when empty (no message to send)", () => {
    expect(formatExpiringIntroPacksDigest([])).toBeNull();
  });

  it("lists an unused_ending (2-Class, still has an unused class) candidate under its own section", () => {
    const out = formatExpiringIntroPacksDigest([
      pack({ name: "Ashley Li", reason: "unused_ending" }),
    ]);
    expect(out).toContain("2 Classes — ainda não fizeram a 2ª aula, poucos dias para terminar:");
    expect(out).toContain("• Ashley Li — termina 22/09/2026");
    expect(out).not.toContain("já fizeram as duas aulas");
    expect(out).not.toContain("10-Day Unlimited");
  });

  it("lists a completed_followup (2-Class, both classes used) candidate with the 2nd-class date", () => {
    const out = formatExpiringIntroPacksDigest([
      pack({ name: "Beatriz Cardoso", reason: "completed_followup", lastVisitOn: "2026-09-28" }),
    ]);
    expect(out).toContain("2 Classes — já fizeram as duas aulas, bom momento para follow-up:");
    expect(out).toContain("• Beatriz Cardoso — 2ª aula em 28/09/2026");
    expect(out).not.toContain("ainda não fizeram a 2ª aula");
  });

  it("lists an ending (10-Day, ending soon) candidate with visit count but no usage threshold in the header", () => {
    const out = formatExpiringIntroPacksDigest([
      pack({
        name: "Dina Silvestre",
        pack: "10-Day",
        packName: "10-Day Unlimited Pass",
        visitCount: 2,
        reason: "ending",
        expiresAt: new Date("2026-09-20T22:59:00Z"),
      }),
    ]);
    expect(out).toContain("10-Day Unlimited — a terminar em breve:");
    expect(out).toContain("• Dina Silvestre — termina 20/09/2026, 2 aulas do pack");
    expect(out).not.toContain("mais de 5 aulas");
  });

  it("lists an underused (10-Day, low usage 5 days in) candidate with the first-visit date", () => {
    const out = formatExpiringIntroPacksDigest([
      pack({
        name: "João Cunha",
        pack: "10-Day",
        packName: "10-Day Unlimited Pass",
        visitCount: 1,
        reason: "underused",
        firstVisitOn: "2026-09-24",
      }),
    ]);
    expect(out).toContain("10-Day Unlimited — pouca utilização (5 dias desde a 1ª aula):");
    expect(out).toContain("• João Cunha — só 1 aula(s) desde 24/09/2026");
  });

  it("includes all four sections when all four kinds of candidates are present", () => {
    const out = formatExpiringIntroPacksDigest([
      pack({ name: "Ashley Li", reason: "unused_ending" }),
      pack({ name: "Beatriz Cardoso", reason: "completed_followup", lastVisitOn: "2026-09-28" }),
      pack({ name: "Dina Silvestre", pack: "10-Day", packName: "10-Day Unlimited Pass", reason: "ending" }),
      pack({
        name: "João Cunha",
        pack: "10-Day",
        packName: "10-Day Unlimited Pass",
        reason: "underused",
        firstVisitOn: "2026-09-24",
      }),
    ]);
    expect(out).toContain("2 Classes — ainda não fizeram a 2ª aula, poucos dias para terminar:");
    expect(out).toContain("2 Classes — já fizeram as duas aulas, bom momento para follow-up:");
    expect(out).toContain("10-Day Unlimited — a terminar em breve:");
    expect(out).toContain("10-Day Unlimited — pouca utilização (5 dias desde a 1ª aula):");
  });

  it("appends phone in parentheses when present", () => {
    const out = formatExpiringIntroPacksDigest([pack({ name: "Ashley Li", phone: "+351912345678" })]);
    expect(out).toContain("• Ashley Li — termina 22/09/2026 (+351912345678)");
  });

  it("no single top-level window claim, since the four buckets don't share one", () => {
    const out = formatExpiringIntroPacksDigest([pack({ name: "Ashley Li" })]);
    expect(out).not.toMatch(/próximos \d+ dias/);
  });
});
