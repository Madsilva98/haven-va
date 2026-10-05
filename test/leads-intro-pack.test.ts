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
const getAllIntroTrackingRows = vi.fn().mockResolvedValue([]);
vi.mock("../src/notion.js", () => ({
  findLeadByEmail: (...args: unknown[]) => findLeadByEmail(...args),
  findLeadByEmailAny: (...args: unknown[]) => findLeadByEmailAny(...args),
  createLead: (...args: unknown[]) => createLead(...args),
  getAllIntroTrackingRows: (...args: unknown[]) => getAllIntroTrackingRows(...args),
}));

import { run } from "../src/crons/leads-intro-pack.js";
import { memberIdFromEmail } from "../src/lib/pulse-views.js";

const candidate = {
  email: "marta@x.com",
  name: "Marta Somborn",
  phone: null,
  packName: "2 Classes | Premium",
  expiresAt: new Date("2026-08-01"),
  daysSinceExpiry: 21,
  isRecent: true,
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
    findUnconvertedIntroPacks.mockResolvedValue({ candidates: [candidate], asOf: "2026-09-18", sourceView: "v_pulse_intro_pack_leads" });
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
    findUnconvertedIntroPacks.mockResolvedValue({ candidates: [candidate], asOf: "2026-09-18", sourceView: "v_pulse_intro_pack_leads" });
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

  it("still creates a Notion lead for a long-overdue candidate, but doesn't re-announce it in the digest — founder's call, 2026-09-28, after a data-path change surfaced an 8-month-old backlog all at once", async () => {
    const oldCandidate = {
      ...candidate,
      email: "francisca@x.com",
      name: "Francisca Rosa",
      daysSinceExpiry: 242,
      isRecent: false,
    };
    findUnconvertedIntroPacks.mockResolvedValue({ candidates: [oldCandidate], asOf: "2026-09-24", sourceView: "v_pulse_intro_pack_leads" });
    findLeadByEmailAny.mockResolvedValue(null);

    await run();

    expect(createLead).toHaveBeenCalledWith(
      "Francisca Rosa",
      "francisca@x.com",
      "Intro Pack",
      expect.any(String),
      "N/A",
      expect.any(String),
      expect.objectContaining({ pack: "2 Classes | Premium" }),
    );
    expect(sendGroupMessage).not.toHaveBeenCalled();
  });

  it("creates every lead but sends no Telegram message at all (founder, 2026-10-05)", async () => {
    const freshCandidate = {
      ...candidate,
      email: "fresh@x.com",
      name: "Fresh Candidate",
      daysSinceExpiry: 24,
      isRecent: true,
    };
    const oldCandidate = {
      ...candidate,
      email: "francisca@x.com",
      name: "Francisca Rosa",
      daysSinceExpiry: 242,
      isRecent: false,
    };
    findUnconvertedIntroPacks.mockResolvedValue({ candidates: [freshCandidate, oldCandidate], asOf: "2026-09-24", sourceView: "v_pulse_intro_pack_leads" });
    findLeadByEmailAny.mockResolvedValue(null);

    await run();

    expect(createLead).toHaveBeenCalledTimes(2);
    expect(sendGroupMessage).not.toHaveBeenCalled();
  });

  it("never turns someone marked Perdido on Tracking intro packs into a lead (founder, 2026-10-02)", async () => {
    process.env.NOTION_INTRO_TRACKING_DB_ID = "test-tracking-db";
    findUnconvertedIntroPacks.mockResolvedValue({ candidates: [candidate], asOf: "2026-09-18", sourceView: "v_pulse_intro_pack_leads" });
    findLeadByEmailAny.mockResolvedValue(null);
    getAllIntroTrackingRows.mockResolvedValue([
      { id: "t1", memberId: memberIdFromEmail("marta@x.com"), nome: "Marta", estado: "Perdido" },
    ]);

    await run();

    expect(createLead).not.toHaveBeenCalled();
    delete process.env.NOTION_INTRO_TRACKING_DB_ID;
    getAllIntroTrackingRows.mockResolvedValue([]);
  });

  it("never turns someone marked Convertido or Comprou outra coisa by hand into a lead (founder, 2026-10-05)", async () => {
    process.env.NOTION_INTRO_TRACKING_DB_ID = "test-tracking-db";
    for (const estado of ["Convertido", "Comprou outra coisa", "Follow up"]) {
      findUnconvertedIntroPacks.mockResolvedValue({ candidates: [candidate], asOf: "2026-09-18", sourceView: "v_pulse_intro_pack_leads" });
      findLeadByEmailAny.mockResolvedValue(null);
      getAllIntroTrackingRows.mockResolvedValue([
        { id: "t1", memberId: memberIdFromEmail("marta@x.com"), nome: "Marta", estado },
      ]);

      await run();

      expect(createLead).not.toHaveBeenCalled();
    }
    delete process.env.NOTION_INTRO_TRACKING_DB_ID;
    getAllIntroTrackingRows.mockResolvedValue([]);
  });

  it("still turns a Cold lead from the tracking list into a lead — Cold lead means 'still worth contacting'", async () => {
    process.env.NOTION_INTRO_TRACKING_DB_ID = "test-tracking-db";
    findUnconvertedIntroPacks.mockResolvedValue({ candidates: [candidate], asOf: "2026-09-18", sourceView: "v_pulse_intro_pack_leads" });
    findLeadByEmailAny.mockResolvedValue(null);
    getAllIntroTrackingRows.mockResolvedValue([
      { id: "t1", memberId: memberIdFromEmail("marta@x.com"), nome: "Marta", estado: "Cold lead" },
    ]);

    await run();

    expect(createLead).toHaveBeenCalledTimes(1);
    delete process.env.NOTION_INTRO_TRACKING_DB_ID;
    getAllIntroTrackingRows.mockResolvedValue([]);
  });

  it("stops the run rather than risk adding a Perdido person when the tracking list can't be read", async () => {
    process.env.NOTION_INTRO_TRACKING_DB_ID = "test-tracking-db";
    findUnconvertedIntroPacks.mockResolvedValue({ candidates: [candidate], asOf: "2026-09-18", sourceView: "v_pulse_intro_pack_leads" });
    getAllIntroTrackingRows.mockRejectedValue(new Error("notion down"));

    await run();

    expect(createLead).not.toHaveBeenCalled();
    delete process.env.NOTION_INTRO_TRACKING_DB_ID;
    getAllIntroTrackingRows.mockResolvedValue([]);
  });
});
