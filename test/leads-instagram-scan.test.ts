import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let fsState: Record<string, unknown> | null = null;
const readFileSync = vi.fn(() => {
  if (!fsState) throw new Error("ENOENT");
  return JSON.stringify(fsState);
});
const writeFileSync = vi.fn((_path: string, data: string) => {
  fsState = JSON.parse(data);
});
const mkdirSync = vi.fn();
vi.mock("node:fs", () => ({
  default: {
    readFileSync: (...args: unknown[]) => readFileSync(...(args as [])),
    writeFileSync: (...args: unknown[]) => writeFileSync(...(args as [string, string])),
    mkdirSync: (...args: unknown[]) => mkdirSync(...args),
  },
  readFileSync: (...args: unknown[]) => readFileSync(...(args as [])),
  writeFileSync: (...args: unknown[]) => writeFileSync(...(args as [string, string])),
  mkdirSync: (...args: unknown[]) => mkdirSync(...args),
}));

const fetchInstagramContactsWithMessages = vi.fn();
const buildTranscript = vi.fn();
const extractVolunteeredEmail = vi.fn();
const extractVolunteeredPhone = vi.fn();
const isExcludedInstagramContact = vi.fn().mockReturnValue(false);
const hasInboundMessage = vi.fn().mockReturnValue(true);
vi.mock("../src/lib/instagram-inbox.js", () => ({
  fetchInstagramContactsWithMessages: (...args: unknown[]) => fetchInstagramContactsWithMessages(...args),
  buildTranscript: (...args: unknown[]) => buildTranscript(...args),
  extractVolunteeredEmail: (...args: unknown[]) => extractVolunteeredEmail(...args),
  extractVolunteeredPhone: (...args: unknown[]) => extractVolunteeredPhone(...args),
  isExcludedInstagramContact: (...args: unknown[]) => isExcludedInstagramContact(...args),
  hasInboundMessage: (...args: unknown[]) => hasInboundMessage(...args),
}));

const checkExistingCustomer = vi.fn();
const fetchAllCustomerNames = vi.fn().mockResolvedValue([]);
vi.mock("../src/lib/leads.js", () => ({
  checkExistingCustomer: (...args: unknown[]) => checkExistingCustomer(...args),
  fetchAllCustomerNames: (...args: unknown[]) => fetchAllCustomerNames(...args),
}));

const classifyInstagramDM = vi.fn();
vi.mock("../src/lib/lead-classifier.js", () => ({
  classifyInstagramDM: (...args: unknown[]) => classifyInstagramDM(...args),
}));

const isStudioSupabaseAvailable = vi.fn().mockReturnValue(true);
vi.mock("../src/lib/studio-supabase.js", () => ({
  isStudioSupabaseAvailable: () => isStudioSupabaseAvailable(),
}));

const sendGroupMessage = vi.fn().mockResolvedValue("msg-id");
vi.mock("../src/lib/telegram.js", () => ({
  sendGroupMessage: (...args: unknown[]) => sendGroupMessage(...args),
}));

const createLead = vi.fn().mockResolvedValue("new-lead-page-id");
const createPartner = vi.fn().mockResolvedValue("new-partner-page-id");
const createInfluencer = vi.fn().mockResolvedValue("new-influencer-page-id");
vi.mock("../src/notion.js", () => ({
  createLead: (...args: unknown[]) => createLead(...args),
  createPartner: (...args: unknown[]) => createPartner(...args),
  createInfluencer: (...args: unknown[]) => createInfluencer(...args),
}));

import { run } from "../src/crons/leads-instagram-scan.js";

const contact = {
  id: "contact-1",
  platformUserId: "ig-1",
  displayName: "Joana Ferreira",
  username: "joanaf",
  messageCount: 3,
  lastMessageAt: "2026-01-01T00:00:00Z",
  messages: [{ direction: "in" as const, text: "quanto custa?", sentAt: "2026-01-01T00:00:00Z" }],
};

describe("leads-instagram-scan", () => {
  beforeEach(() => {
    process.env.NOTION_LEADS_DB_ID = "test-leads-db";
    fsState = null;
  });

  afterEach(() => {
    delete process.env.NOTION_LEADS_DB_ID;
    fetchInstagramContactsWithMessages.mockReset();
    buildTranscript.mockReset();
    extractVolunteeredEmail.mockReset();
    extractVolunteeredPhone.mockReset();
    isExcludedInstagramContact.mockReset().mockReturnValue(false);
    hasInboundMessage.mockReset().mockReturnValue(true);
    checkExistingCustomer.mockReset();
    fetchAllCustomerNames.mockReset().mockResolvedValue([]);
    classifyInstagramDM.mockReset();
    isStudioSupabaseAvailable.mockReturnValue(true);
    sendGroupMessage.mockClear();
    createLead.mockClear().mockResolvedValue("new-lead-page-id");
    createPartner.mockClear().mockResolvedValue("new-partner-page-id");
    createInfluencer.mockClear().mockResolvedValue("new-influencer-page-id");
    readFileSync.mockClear();
    writeFileSync.mockClear();
  });

  it("creates a lead for a genuine client information request with no existing CRM match", async () => {
    fetchInstagramContactsWithMessages.mockResolvedValue([contact]);
    buildTranscript.mockReturnValue("Cliente: quanto custa?");
    classifyInstagramDM.mockResolvedValue("cliente");
    extractVolunteeredEmail.mockReturnValue(null);
    extractVolunteeredPhone.mockReturnValue(null);
    checkExistingCustomer.mockResolvedValue({ isExistingCustomer: false, fuzzyMatch: null });

    await run();

    expect(createLead).toHaveBeenCalledWith(
      "Joana Ferreira",
      null,
      "Instagram",
      expect.any(String),
      "Sem correspondência",
      expect.any(String),
      { telefone: null },
    );
    expect(createPartner).not.toHaveBeenCalled();
    expect(sendGroupMessage).toHaveBeenCalledTimes(1);
  });

  it("routes a business/networking contact to Partner Pipeline instead of Leads a contactar", async () => {
    fetchInstagramContactsWithMessages.mockResolvedValue([contact]);
    buildTranscript.mockReturnValue("Cliente: adorava fazer uma parceria com a Haven!");
    classifyInstagramDM.mockResolvedValue("parceiro");

    await run();

    expect(createPartner).toHaveBeenCalledWith(
      "Joana Ferreira",
      "Unassigned",
      expect.any(String),
      "Parceria",
      "A contactar",
      "2026-01-01T00:00:00Z",
    );
    expect(createLead).not.toHaveBeenCalled();
    expect(checkExistingCustomer).not.toHaveBeenCalled();
    expect(sendGroupMessage).toHaveBeenCalledTimes(1);
    const [message] = sendGroupMessage.mock.calls[0]!;
    expect(message).toContain("parceiro");
  });

  it("routes a content-for-exposure pitch to Influencer Pipeline, not Partner Pipeline", async () => {
    fetchInstagramContactsWithMessages.mockResolvedValue([contact]);
    buildTranscript.mockReturnValue("Cliente: adorava experimentar uma aula e partilhar nos meus stories!");
    classifyInstagramDM.mockResolvedValue("influencer");

    await run();

    expect(createInfluencer).toHaveBeenCalledWith(
      "Joana Ferreira",
      "Unassigned",
      expect.any(String),
      "Instagram DM",
      "2026-01-01T00:00:00Z",
    );
    expect(createPartner).not.toHaveBeenCalled();
    expect(createLead).not.toHaveBeenCalled();
    expect(sendGroupMessage).toHaveBeenCalledTimes(1);
    const [message] = sendGroupMessage.mock.calls[0]!;
    expect(message).toContain("influencer");
  });

  it("does not create a lead or partner when the transcript is neither", async () => {
    fetchInstagramContactsWithMessages.mockResolvedValue([contact]);
    buildTranscript.mockReturnValue("Cliente: adoro o vosso estúdio!");
    classifyInstagramDM.mockResolvedValue("nenhum");

    await run();

    expect(createLead).not.toHaveBeenCalled();
    expect(createPartner).not.toHaveBeenCalled();
    expect(sendGroupMessage).not.toHaveBeenCalled();
  });

  it("skips excluded contacts without calling the classifier", async () => {
    fetchInstagramContactsWithMessages.mockResolvedValue([contact]);
    isExcludedInstagramContact.mockReturnValue(true);

    await run();

    expect(classifyInstagramDM).not.toHaveBeenCalled();
    expect(createLead).not.toHaveBeenCalled();
    expect(createPartner).not.toHaveBeenCalled();
  });

  it("logs a studio-only outreach contact (no reply) as an already-contacted partner, without calling the classifier — regression for the 2026-09-21 false-partner-classification incident", async () => {
    fetchInstagramContactsWithMessages.mockResolvedValue([contact]);
    hasInboundMessage.mockReturnValue(false);
    buildTranscript.mockReturnValue("Haven: queríamos explorar uma parceria convosco!");

    await run();

    expect(classifyInstagramDM).not.toHaveBeenCalled();
    expect(createLead).not.toHaveBeenCalled();
    expect(createPartner).toHaveBeenCalledWith(
      "Joana Ferreira",
      "Unassigned",
      expect.any(String),
      "Parceria",
      "Contactado",
      "2026-01-01T00:00:00Z",
    );
  });

  it("skips a studio-only outreach contact with no text at all (edge case)", async () => {
    fetchInstagramContactsWithMessages.mockResolvedValue([contact]);
    hasInboundMessage.mockReturnValue(false);
    buildTranscript.mockReturnValue("");

    await run();

    expect(classifyInstagramDM).not.toHaveBeenCalled();
    expect(createPartner).not.toHaveBeenCalled();
    expect(createLead).not.toHaveBeenCalled();
  });

  it("skips a contact with no new activity since it was already checked", async () => {
    fsState = {
      "contact-1": { messageCountSeen: 3, classification: "nenhum", notionPageId: null, classifiedAt: "x" },
    };
    fetchInstagramContactsWithMessages.mockResolvedValue([contact]);

    await run();

    expect(classifyInstagramDM).not.toHaveBeenCalled();
    expect(createLead).not.toHaveBeenCalled();
    expect(createPartner).not.toHaveBeenCalled();
  });

  it("reclassifies a previously-rejected contact once new messages arrive", async () => {
    fsState = {
      "contact-1": { messageCountSeen: 1, classification: "nenhum", notionPageId: null, classifiedAt: "x" },
    };
    fetchInstagramContactsWithMessages.mockResolvedValue([contact]); // now messageCount: 3
    buildTranscript.mockReturnValue("Cliente: quanto custa?");
    classifyInstagramDM.mockResolvedValue("cliente");
    extractVolunteeredEmail.mockReturnValue(null);
    extractVolunteeredPhone.mockReturnValue(null);
    checkExistingCustomer.mockResolvedValue({ isExistingCustomer: false, fuzzyMatch: null });

    await run();

    expect(classifyInstagramDM).toHaveBeenCalled();
    expect(createLead).toHaveBeenCalled();
  });

  it("never creates a second lead for a contact that already has a notionPageId, even with new messages", async () => {
    fsState = {
      "contact-1": {
        messageCountSeen: 1,
        classification: "cliente",
        notionPageId: "existing-page",
        classifiedAt: "x",
      },
    };
    fetchInstagramContactsWithMessages.mockResolvedValue([contact]); // now messageCount: 3, i.e. new activity

    await run();

    expect(classifyInstagramDM).not.toHaveBeenCalled();
    expect(createLead).not.toHaveBeenCalled();
    // the checkpoint's message count is still refreshed to stay accurate
    expect((fsState as Record<string, { messageCountSeen: number }>)["contact-1"]?.messageCountSeen).toBe(3);
  });

  it("never creates a second partner page for a contact that already has one, even with new messages", async () => {
    fsState = {
      "contact-1": {
        messageCountSeen: 1,
        classification: "parceiro",
        notionPageId: "existing-partner-page",
        classifiedAt: "x",
      },
    };
    fetchInstagramContactsWithMessages.mockResolvedValue([contact]);

    await run();

    expect(classifyInstagramDM).not.toHaveBeenCalled();
    expect(createPartner).not.toHaveBeenCalled();
  });

  it("does not create a lead for someone who already has a real purchase on file", async () => {
    fetchInstagramContactsWithMessages.mockResolvedValue([contact]);
    buildTranscript.mockReturnValue("Cliente: quanto custa?");
    classifyInstagramDM.mockResolvedValue("cliente");
    extractVolunteeredEmail.mockReturnValue("joana@example.com");
    extractVolunteeredPhone.mockReturnValue(null);
    checkExistingCustomer.mockResolvedValue({ isExistingCustomer: true, fuzzyMatch: null });

    await run();

    expect(createLead).not.toHaveBeenCalled();
  });

  it("flags a fuzzy CRM name match for manual review instead of suppressing the write", async () => {
    fetchInstagramContactsWithMessages.mockResolvedValue([contact]);
    buildTranscript.mockReturnValue("Cliente: quanto custa?");
    classifyInstagramDM.mockResolvedValue("cliente");
    extractVolunteeredEmail.mockReturnValue(null);
    extractVolunteeredPhone.mockReturnValue(null);
    checkExistingCustomer.mockResolvedValue({
      isExistingCustomer: false,
      fuzzyMatch: { name: "Joana Ferreira", email: "joana@x.com", score: 0.9 },
    });

    await run();

    expect(createLead).toHaveBeenCalledWith(
      "Joana Ferreira",
      null,
      "Instagram",
      expect.any(String),
      "Match incerto — rever manualmente",
      expect.any(String),
      { telefone: null },
    );
  });
});
