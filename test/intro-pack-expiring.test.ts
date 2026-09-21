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
    ...overrides,
  };
}

describe("formatExpiringIntroPacksDigest", () => {
  it("returns null when empty (no message to send)", () => {
    expect(formatExpiringIntroPacksDigest([])).toBeNull();
  });

  it("lists a 2 Classes candidate under its own section", () => {
    const out = formatExpiringIntroPacksDigest([
      pack({ name: "Ashley Li", packName: "2 Classes | Premium", visitCount: 1 }),
    ]);
    expect(out).toContain("2 Classes — só usaram 1 aula:");
    expect(out).toContain("• Ashley Li");
    expect(out).not.toContain("10-Day Unlimited");
  });

  it("lists a 10-Day Unlimited candidate under its own section, with visit count", () => {
    const out = formatExpiringIntroPacksDigest([
      pack({
        name: "Dina Silvestre",
        pack: "10-Day",
        packName: "10-Day Unlimited Pass",
        visitCount: 15,
        expiresAt: new Date("2026-09-20T22:59:00Z"),
      }),
    ]);
    expect(out).toContain("10-Day Unlimited — já fizeram mais de 5 aulas:");
    expect(out).toContain("• Dina Silvestre — termina 20/09/2026, 15 aulas");
    expect(out).not.toContain("2 Classes —");
  });

  it("includes both sections when both kinds of candidates are present", () => {
    const out = formatExpiringIntroPacksDigest([
      pack({ name: "Ashley Li", packName: "2 Classes | Premium", visitCount: 1 }),
      pack({ name: "Dina Silvestre", pack: "10-Day",
        packName: "10-Day Unlimited Pass", visitCount: 15 }),
    ]);
    expect(out).toContain("2 Classes — só usaram 1 aula:");
    expect(out).toContain("10-Day Unlimited — já fizeram mais de 5 aulas:");
  });

  it("appends phone in parentheses when present", () => {
    const out = formatExpiringIntroPacksDigest([pack({ name: "Ashley Li", phone: "+351912345678" })]);
    expect(out).toContain("• Ashley Li — termina 22/09/2026 (+351912345678)");
  });
});
