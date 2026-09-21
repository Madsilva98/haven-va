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

const isStudioDbAvailable = vi.fn().mockReturnValue(true);
vi.mock("../src/lib/studio-db.js", () => ({
  isStudioDbAvailable: () => isStudioDbAvailable(),
}));

const loadConversionCheckData = vi.fn();
vi.mock("../src/lib/intro-pack-conversion.js", () => ({
  loadConversionCheckData: (...args: unknown[]) => loadConversionCheckData(...args),
}));

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
    isStudioDbAvailable.mockReturnValue(true);
    loadConversionCheckData.mockReset();
  });

  it("archives Perdido, Convertido, and Inconclusivo rows unconditionally — the list must stay 'viva'", async () => {
    getLeadsByEstado.mockImplementation(async (estados: string[]) =>
      estados.includes("Perdido")
        ? [
            { id: "p1", email: "a@x.com", estado: "Perdido", canal: "Email" },
            // Manually marked Convertido by the founder in Notion — must be
            // archived outright, not left visible in the list.
            { id: "c1", email: "b@x.com", estado: "Convertido", canal: "Intro Pack" },
            // Founder couldn't tell from the DM thread whether this converted
            // or was lost — same terminal weight as the other two.
            { id: "i1", email: "c@x.com", estado: "Inconclusivo", canal: "Instagram" },
          ]
        : [],
    );
    loadConversionCheckData.mockResolvedValue({
      firstPackByEmail: new Map(),
      convertedMemberIds: new Set(),
    });

    await run();

    expect(getLeadsByEstado).toHaveBeenCalledWith(["Perdido", "Convertido", "Inconclusivo"]);
    expect(archivePage).toHaveBeenCalledWith("p1");
    expect(archivePage).toHaveBeenCalledWith("c1");
    expect(archivePage).toHaveBeenCalledWith("i1");
  });

  it("does NOT archive a Perdido or Inconclusivo Intro Pack row — regression for the 2026-09-21 resurrection incident (Marta Somborn)", async () => {
    getLeadsByEstado.mockImplementation(async (estados: string[]) =>
      estados.includes("Perdido")
        ? [
            { id: "p2", email: "marta@x.com", estado: "Perdido", canal: "Intro Pack" },
            { id: "i2", email: "outro@x.com", estado: "Inconclusivo", canal: "Intro Pack" },
          ]
        : [],
    );
    loadConversionCheckData.mockResolvedValue({
      firstPackByEmail: new Map(),
      subsByEmail: new Map(),
      membershipsByEmail: new Map(),
    });

    await run();

    expect(archivePage).not.toHaveBeenCalledWith("p2");
    expect(archivePage).not.toHaveBeenCalledWith("i2");
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
      convertedMemberIds: new Set(),
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
        ["intro-lead@x.com", { memberId: "m-intro", email: "intro-lead@x.com", name: "Intro Lead", pack: "2-Class", packName: "2 Classes | Premium", purchasedAt: new Date("2026-06-01"), expiresAt: new Date("2026-06-15"), activated: true }],
      ]),
      convertedMemberIds: new Set(), // v_pulse_intro_conversion: neither converted nor converted_pack
    });

    await run();

    expect(hasRealPurchase).not.toHaveBeenCalled();
    expect(archivePage).not.toHaveBeenCalledWith("ip1");
  });

  it("archives an Intro Pack lead the conversion view says converted (membership or 5x/10x pack, mid-pack counts)", async () => {
    getLeadsByEstado.mockImplementation(async (estados: string[]) =>
      estados.includes("Novo")
        ? [{ id: "ip2", email: "converted@x.com", estado: "Novo", canal: "Intro Pack" }]
        : [],
    );
    loadConversionCheckData.mockResolvedValue({
      firstPackByEmail: new Map([
        ["converted@x.com", { memberId: "m-converted", email: "converted@x.com", name: "Converted", pack: "2-Class", packName: "2 Classes | Premium", purchasedAt: new Date("2026-06-01"), expiresAt: new Date("2026-06-15"), activated: true }],
      ]),
      convertedMemberIds: new Set(["m-converted"]), // v_pulse_intro_conversion says converted
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
      convertedMemberIds: new Set(),
    });

    await run();

    expect(archivePage).not.toHaveBeenCalledWith("ip3");
  });
});
