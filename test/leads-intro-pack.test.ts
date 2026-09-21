import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const findUnconvertedIntroPacks = vi.fn();
const describePostExpiryVisit = vi.fn().mockReturnValue(null);
vi.mock("../src/lib/intro-pack-conversion.js", () => ({
  findUnconvertedIntroPacks: (...args: unknown[]) => findUnconvertedIntroPacks(...args),
  describePostExpiryVisit: (...args: unknown[]) => describePostExpiryVisit(...args),
}));

const isStudioDbAvailable = vi.fn().mockReturnValue(true);
vi.mock("../src/lib/studio-db.js", () => ({
  isStudioDbAvailable: () => isStudioDbAvailable(),
}));

const sendGroupMessage = vi.fn().mockResolvedValue("msg-id");
vi.mock("../src/lib/telegram.js", () => ({
  sendGroupMessage: (...args: unknown[]) => sendGroupMessage(...args),
}));

const findLeadByEmail = vi.fn();
const findLeadByEmailAny = vi.fn();
const createLead = vi.fn().mockResolvedValue("new-page-id");
vi.mock("../src/notion.js", () => ({
  findLeadByEmail: (...args: unknown[]) => findLeadByEmail(...args),
  findLeadByEmailAny: (...args: unknown[]) => findLeadByEmailAny(...args),
  createLead: (...args: unknown[]) => createLead(...args),
}));

import { run } from "../src/crons/leads-intro-pack.js";

const candidate = {
  email: "marta@x.com",
  name: "Marta Somborn",
  phone: null,
  packName: "2 Classes | Premium",
  expiresAt: new Date("2026-08-01"),
  daysSinceExpiry: 21,
  lastVisit: null,
  visitCount: 0,
};

describe("leads-intro-pack", () => {
  beforeEach(() => {
    process.env.NOTION_LEADS_DB_ID = "test-leads-db";
  });

  afterEach(() => {
    delete process.env.NOTION_LEADS_DB_ID;
    findUnconvertedIntroPacks.mockReset();
    describePostExpiryVisit.mockReset().mockReturnValue(null);
    isStudioDbAvailable.mockReturnValue(true);
    sendGroupMessage.mockClear();
    findLeadByEmail.mockReset();
    findLeadByEmailAny.mockReset();
    createLead.mockClear();
  });

  it("does not recreate a lead the founder already marked Perdido — regression for the 2026-09-21 resurrection incident (Marta Somborn)", async () => {
    findUnconvertedIntroPacks.mockResolvedValue({ candidates: [candidate], asOf: "2026-09-18" });
    // The row is un-archived (leads-reconcile.ts now leaves Perdido Intro
    // Pack rows alone) but Estado=Perdido, so only the unfiltered dedup
    // check sees it.
    findLeadByEmailAny.mockResolvedValue({ id: "old-row", estado: "Perdido" });

    await run();

    expect(findLeadByEmailAny).toHaveBeenCalledWith("marta@x.com", "Intro Pack");
    expect(findLeadByEmail).not.toHaveBeenCalled();
    expect(createLead).not.toHaveBeenCalled();
  });

  it("creates a lead for a genuinely new candidate, scoping the dedup check to the Intro Pack channel", async () => {
    // notion.findLeadByEmailAny(email, "Intro Pack") is relied on in
    // production to filter by Canal too — a Perdido/Convertido row on an
    // unrelated channel (e.g. not yet archived after a transient failure)
    // must not match and block this create.
    findUnconvertedIntroPacks.mockResolvedValue({ candidates: [candidate], asOf: "2026-09-18" });
    findLeadByEmailAny.mockResolvedValue(null);

    await run();

    expect(findLeadByEmailAny).toHaveBeenCalledWith("marta@x.com", "Intro Pack");
    expect(createLead).toHaveBeenCalledWith(
      "Marta Somborn",
      "marta@x.com",
      "Intro Pack",
      expect.any(String),
      "N/A",
      expect.any(String),
      expect.objectContaining({ pack: "2 Classes | Premium" }),
    );
  });
});
