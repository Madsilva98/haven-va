import { beforeEach, describe, expect, it, vi } from "vitest";

const views = vi.hoisted(() => ({
  fetchReferralGuestLeads: vi.fn(async (): Promise<unknown[] | null> => null),
  fetchMemberIdentity: vi.fn(async () => [{ member_id: "ana", contact_name: "Ana Silva", contact_email: "ana@x.pt", contact_phone: null }]),
}));
vi.mock("../src/lib/pulse-views.js", () => ({ ...views, PULSE_VIEW: { referralGuestLeads: "v_pulse_referral_guest_leads" } }));
vi.mock("../src/lib/studio-db.js", () => ({ isStudioDbAvailable: () => true }));
const notion = vi.hoisted(() => ({
  getAllReferralGuestRows: vi.fn(async (): Promise<unknown[]> => []),
  createReferralGuestRow: vi.fn(async () => "page-1"),
  updateReferralGuestRow: vi.fn(async () => undefined),
  findLeadByEmail: vi.fn(async (): Promise<unknown> => null),
  createLead: vi.fn(async () => "lead-1"),
}));
vi.mock("../src/notion.js", () => notion);
const send = vi.fn(async (..._a: unknown[]) => 1);
vi.mock("../src/lib/pulse-source.js", () => ({ sendGroupMessageWithSource: (...a: unknown[]) => send(...a) }));

import { run } from "../src/crons/referral-guest-leads.js";

const row = (state: string) => ({
  member_id: "ana",
  origin: "guest",
  brought_by_member_id: null,
  brought_by_name: "Rita",
  entered_on: "2026-09-01",
  guest_classes: 1,
  classes_done: 1,
  intro_bought_on: null,
  membership_on: null,
  other_purchase_on: null,
  state,
  data_as_of: "2026-10-15",
});

beforeEach(() => {
  vi.clearAllMocks();
  process.env.NOTION_REFERRAL_GUESTS_DB_ID = "db";
  process.env.NOTION_LEADS_DB_ID = "leads";
  delete process.env.REFERRAL_GUESTS_DRY_RUN;
  views.fetchReferralGuestLeads.mockResolvedValue(null);
  notion.getAllReferralGuestRows.mockResolvedValue([]);
  notion.findLeadByEmail.mockResolvedValue(null);
});

describe("referral-guest-leads cron", () => {
  it("does nothing until the view exists", async () => {
    await run();
    expect(notion.getAllReferralGuestRows).not.toHaveBeenCalled();
  });

  it("a new open person: created and announced", async () => {
    views.fetchReferralGuestLeads.mockResolvedValue([row("open")]);
    await run();
    expect(notion.createReferralGuestRow).toHaveBeenCalledWith("Ana Silva", "ana", expect.anything(), "A contactar");
    expect(String(send.mock.calls[0]![0])).toContain("· Ana Silva: Convidado via Rita");
    expect(send.mock.calls[0]![1]).toEqual(["v_pulse_referral_guest_leads"]);
  });

  it("cold: Cold lead and one lead with Canal Convidado, silent", async () => {
    views.fetchReferralGuestLeads.mockResolvedValue([row("cold")]);
    await run();
    expect(notion.createLead).toHaveBeenCalledWith(
      "Ana Silva",
      "ana@x.pt",
      "Convidado",
      "Convidado via Rita desde 2026-09-01; sem compras 30 dias depois.",
      "N/A",
      "Referidos e convidados (cold)",
      { nVisitas: 1 },
    );
    expect(send).not.toHaveBeenCalled();
  });

  it("cold: no second lead when one is already open for the email", async () => {
    views.fetchReferralGuestLeads.mockResolvedValue([row("cold")]);
    notion.findLeadByEmail.mockResolvedValue({ id: "lead-0", estado: "Novo" });
    await run();
    expect(notion.createLead).not.toHaveBeenCalled();
  });

  it("dry run writes and posts nothing", async () => {
    process.env.REFERRAL_GUESTS_DRY_RUN = "true";
    views.fetchReferralGuestLeads.mockResolvedValue([row("open")]);
    await run();
    expect(notion.createReferralGuestRow).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("an empty view with rows in the list writes nothing", async () => {
    views.fetchReferralGuestLeads.mockResolvedValue([]);
    notion.getAllReferralGuestRows.mockResolvedValue([{ id: "p", memberId: "ana", nome: "Ana", estado: "A contactar" }]);
    await run();
    expect(notion.updateReferralGuestRow).not.toHaveBeenCalled();
  });
});
