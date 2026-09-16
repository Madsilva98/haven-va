import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getLeadsByEstado = vi.fn();
const archivePage = vi.fn().mockResolvedValue(undefined);
vi.mock("../src/notion.js", () => ({
  getLeadsByEstado: (...args: unknown[]) => getLeadsByEstado(...args),
  archivePage: (...args: unknown[]) => archivePage(...args),
}));

const hasRealPurchase = vi.fn();
vi.mock("../src/lib/leads.js", () => ({
  hasRealPurchase: (...args: unknown[]) => hasRealPurchase(...args),
}));

const isStudioSupabaseAvailable = vi.fn().mockReturnValue(true);
vi.mock("../src/lib/studio-supabase.js", () => ({
  isStudioSupabaseAvailable: () => isStudioSupabaseAvailable(),
}));

const loadConversionCheckData = vi.fn();
vi.mock("../src/lib/intro-pack-conversion.js", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/intro-pack-conversion.js")>(
    "../src/lib/intro-pack-conversion.js",
  );
  return {
    hasConvertedAfter: actual.hasConvertedAfter,
    loadConversionCheckData: (...args: unknown[]) => loadConversionCheckData(...args),
  };
});

import { run } from "../src/crons/leads-reconcile.js";

describe("leads-reconcile", () => {
  beforeEach(() => {
    process.env.NOTION_LEADS_DB_ID = "test-leads-db";
  });

  afterEach(() => {
    delete process.env.NOTION_LEADS_DB_ID;
    getLeadsByEstado.mockReset();
    archivePage.mockClear();
    hasRealPurchase.mockReset();
    isStudioSupabaseAvailable.mockReturnValue(true);
    loadConversionCheckData.mockReset();
  });

  it("archives Perdido rows unconditionally", async () => {
    getLeadsByEstado.mockImplementation(async (estados: string[]) =>
      estados[0] === "Perdido" ? [{ id: "p1", email: "a@x.com", estado: "Perdido", canal: "Email" }] : [],
    );
    loadConversionCheckData.mockResolvedValue({
      firstPackByEmail: new Map(),
      subsByEmail: new Map(),
      membershipsByEmail: new Map(),
    });

    await run();

    expect(archivePage).toHaveBeenCalledWith("p1");
  });

  it("archives an Email-channel lead that now has a real purchase on file", async () => {
    getLeadsByEstado.mockImplementation(async (estados: string[]) =>
      estados.includes("Novo")
        ? [{ id: "e1", email: "email-lead@x.com", estado: "Novo", canal: "Email" }]
        : [],
    );
    hasRealPurchase.mockResolvedValue(true);
    loadConversionCheckData.mockResolvedValue({
      firstPackByEmail: new Map(),
      subsByEmail: new Map(),
      membershipsByEmail: new Map(),
    });

    await run();

    expect(hasRealPurchase).toHaveBeenCalledWith("email-lead@x.com");
    expect(archivePage).toHaveBeenCalledWith("e1");
  });

  it("does NOT archive an Intro Pack lead just because hasRealPurchase is true — regression for the 2026-09-16 mass-archive incident", async () => {
    getLeadsByEstado.mockImplementation(async (estados: string[]) =>
      estados.includes("Novo")
        ? [{ id: "ip1", email: "intro-lead@x.com", estado: "Novo", canal: "Intro Pack" }]
        : [],
    );
    // The lead's own intro-pack purchase would make this true — it must
    // never be consulted for Intro Pack rows.
    hasRealPurchase.mockResolvedValue(true);
    loadConversionCheckData.mockResolvedValue({
      firstPackByEmail: new Map([
        ["intro-lead@x.com", { email: "intro-lead@x.com", name: "Intro Lead", packName: "2 Classes | Premium", startsAt: new Date("2026-06-01"), expiresAt: new Date("2026-06-15") }],
      ]),
      subsByEmail: new Map(), // never started a subscription
      membershipsByEmail: new Map(), // never started a non-intro membership
    });

    await run();

    expect(hasRealPurchase).not.toHaveBeenCalled();
    expect(archivePage).not.toHaveBeenCalledWith("ip1");
  });

  it("archives an Intro Pack lead that genuinely converted after their pack expired", async () => {
    getLeadsByEstado.mockImplementation(async (estados: string[]) =>
      estados.includes("Novo")
        ? [{ id: "ip2", email: "converted@x.com", estado: "Novo", canal: "Intro Pack" }]
        : [],
    );
    loadConversionCheckData.mockResolvedValue({
      firstPackByEmail: new Map([
        ["converted@x.com", { email: "converted@x.com", name: "Converted", packName: "2 Classes | Premium", startsAt: new Date("2026-06-01"), expiresAt: new Date("2026-06-15") }],
      ]),
      subsByEmail: new Map([["converted@x.com", [new Date("2026-07-01")]]]), // started a subscription after expiry
      membershipsByEmail: new Map(),
    });

    await run();

    expect(archivePage).toHaveBeenCalledWith("ip2");
  });

  it("leaves an Intro Pack lead alone when no matching pack record is found", async () => {
    getLeadsByEstado.mockImplementation(async (estados: string[]) =>
      estados.includes("Novo")
        ? [{ id: "ip3", email: "unknown@x.com", estado: "Novo", canal: "Intro Pack" }]
        : [],
    );
    loadConversionCheckData.mockResolvedValue({
      firstPackByEmail: new Map(),
      subsByEmail: new Map(),
      membershipsByEmail: new Map(),
    });

    await run();

    expect(archivePage).not.toHaveBeenCalledWith("ip3");
  });
});
