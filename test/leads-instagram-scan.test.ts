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
const fetchAllVisitHistory = vi.fn().mockResolvedValue(new Map());
const findVisitHistory = vi.fn().mockReturnValue(null);
const findBestNameMatch = vi.fn().mockReturnValue(null);
vi.mock("../src/lib/leads.js", () => ({
  checkExistingCustomer: (...args: unknown[]) => checkExistingCustomer(...args),
  fetchAllCustomerNames: (...args: unknown[]) => fetchAllCustomerNames(...args),
  fetchAllVisitHistory: (...args: unknown[]) => fetchAllVisitHistory(...args),
  findVisitHistory: (...args: unknown[]) => findVisitHistory(...args),
  findBestNameMatch: (...args: unknown[]) => findBestNameMatch(...args),
}));

const classifyInstagramDM = vi.fn();
const classifyOutreachIntent = vi.fn().mockResolvedValue("parceiro");
const enrichPartnerFromTranscript = vi.fn().mockResolvedValue(null);
const enrichInfluencerFromTranscript = vi.fn().mockResolvedValue(null);
const summarizeRelationshipUpdate = vi.fn().mockResolvedValue("");
vi.mock("../src/lib/lead-classifier.js", () => ({
  classifyInstagramDM: (...args: unknown[]) => classifyInstagramDM(...args),
  classifyOutreachIntent: (...args: unknown[]) => classifyOutreachIntent(...args),
  enrichPartnerFromTranscript: (...args: unknown[]) => enrichPartnerFromTranscript(...args),
  enrichInfluencerFromTranscript: (...args: unknown[]) => enrichInfluencerFromTranscript(...args),
  summarizeRelationshipUpdate: (...args: unknown[]) => summarizeRelationshipUpdate(...args),
}));

const isStudioDbAvailable = vi.fn().mockReturnValue(true);
vi.mock("../src/lib/studio-db.js", () => ({
  isStudioDbAvailable: () => isStudioDbAvailable(),
}));

const sendGroupMessage = vi.fn().mockResolvedValue("msg-id");
vi.mock("../src/lib/telegram.js", () => ({
  sendGroupMessage: (...args: unknown[]) => sendGroupMessage(...args),
}));

const createLead = vi.fn().mockResolvedValue("new-lead-page-id");
const createPartner = vi.fn().mockResolvedValue("new-partner-page-id");
const createInfluencer = vi.fn().mockResolvedValue("new-influencer-page-id");
const appendToPageSection = vi.fn().mockResolvedValue(undefined);
const replacePageSection = vi.fn().mockResolvedValue(undefined);
const updateInfluencerFields = vi.fn().mockResolvedValue(undefined);
const getAllPartnerContacts = vi.fn().mockResolvedValue([]);
const getAllInfluencerContacts = vi.fn().mockResolvedValue([]);
vi.mock("../src/notion.js", () => ({
  createLead: (...args: unknown[]) => createLead(...args),
  createPartner: (...args: unknown[]) => createPartner(...args),
  createInfluencer: (...args: unknown[]) => createInfluencer(...args),
  appendToPageSection: (...args: unknown[]) => appendToPageSection(...args),
  replacePageSection: (...args: unknown[]) => replacePageSection(...args),
  updateInfluencerFields: (...args: unknown[]) => updateInfluencerFields(...args),
  getAllPartnerContacts: (...args: unknown[]) => getAllPartnerContacts(...args),
  getAllInfluencerContacts: (...args: unknown[]) => getAllInfluencerContacts(...args),
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
    fetchAllVisitHistory.mockReset().mockResolvedValue(new Map());
    findVisitHistory.mockReset().mockReturnValue(null);
    findBestNameMatch.mockReset().mockReturnValue(null);
    classifyInstagramDM.mockReset();
    classifyOutreachIntent.mockReset().mockResolvedValue("parceiro");
    enrichPartnerFromTranscript.mockReset().mockResolvedValue(null);
    enrichInfluencerFromTranscript.mockReset().mockResolvedValue(null);
    summarizeRelationshipUpdate.mockReset().mockResolvedValue("");
    isStudioDbAvailable.mockReturnValue(true);
    sendGroupMessage.mockClear();
    createLead.mockClear().mockResolvedValue("new-lead-page-id");
    createPartner.mockClear().mockResolvedValue("new-partner-page-id");
    createInfluencer.mockClear().mockResolvedValue("new-influencer-page-id");
    appendToPageSection.mockClear().mockResolvedValue(undefined);
    replacePageSection.mockClear().mockResolvedValue(undefined);
    updateInfluencerFields.mockClear().mockResolvedValue(undefined);
    getAllPartnerContacts.mockReset().mockResolvedValue([]);
    getAllInfluencerContacts.mockReset().mockResolvedValue([]);
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

  it("routes a studio-only outreach contact to Influencer Pipeline when our own message is the team's influencer-outreach template — regression for the 2026-09-21 Márcia Soares misroute", async () => {
    fetchInstagramContactsWithMessages.mockResolvedValue([contact]);
    hasInboundMessage.mockReturnValue(false);
    buildTranscript.mockReturnValue(
      "Haven: Estamos a contactar várias pessoas que achamos que fazem match com a nossa vibe para virem experimentar uma aula connosco.",
    );
    classifyOutreachIntent.mockResolvedValue("influencer");

    await run();

    expect(classifyInstagramDM).not.toHaveBeenCalled();
    expect(createPartner).not.toHaveBeenCalled();
    expect(createInfluencer).toHaveBeenCalledWith(
      "Joana Ferreira",
      "Unassigned",
      expect.any(String),
      "Instagram DM",
      "2026-01-01T00:00:00Z",
      "Contactado",
    );
  });

  it("skips creating a partner page when the name fuzzy-matches an existing Partner Pipeline row, and flags it in the digest — regression for the 2026-09-21 Wanderlust/Wanderlust_Portugal duplicate", async () => {
    fetchInstagramContactsWithMessages.mockResolvedValue([contact]);
    buildTranscript.mockReturnValue("Cliente: adorava fazer uma parceria com a Haven!");
    classifyInstagramDM.mockResolvedValue("parceiro");
    getAllPartnerContacts.mockResolvedValue([{ id: "existing-id", name: "Joana Ferreira Lda" }]);

    await run();

    expect(createPartner).not.toHaveBeenCalled();
    expect(sendGroupMessage).toHaveBeenCalledWith(
      expect.stringContaining('parece igual a "Joana Ferreira Lda"'),
    );
    // checkpointed with no page id, so it isn't retried every run
    expect((fsState as Record<string, { notionPageId: string | null }>)["contact-1"]?.notionPageId).toBeNull();
  });

  it("skips creating an influencer page when the name fuzzy-matches an existing Influencer Pipeline row", async () => {
    fetchInstagramContactsWithMessages.mockResolvedValue([contact]);
    buildTranscript.mockReturnValue("Cliente: adorava experimentar uma aula e partilhar nos meus stories!");
    classifyInstagramDM.mockResolvedValue("influencer");
    getAllInfluencerContacts.mockResolvedValue([{ id: "existing-id", name: "Joana Ferreira" }]);

    await run();

    expect(createInfluencer).not.toHaveBeenCalled();
    expect(sendGroupMessage).toHaveBeenCalledWith(expect.stringContaining("Influencer Pipeline"));
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

  it("enriches a newly-created partner page: replaces Sobre/Deal, appends the initial Log entry", async () => {
    fetchInstagramContactsWithMessages.mockResolvedValue([contact]);
    buildTranscript.mockReturnValue("Cliente: adorava fazer uma parceria com a Haven!");
    classifyInstagramDM.mockResolvedValue("parceiro");
    enrichPartnerFromTranscript.mockResolvedValue({
      sobre: "Estúdio de massagem em Cascais",
      deal: "Workshop conjunto em outubro",
      log: "Propôs um workshop conjunto.",
    });

    await run();

    expect(replacePageSection).toHaveBeenCalledWith(
      "new-partner-page-id",
      "Estúdio de massagem em Cascais",
      "Sobre o parceiro",
    );
    expect(replacePageSection).toHaveBeenCalledWith(
      "new-partner-page-id",
      "Workshop conjunto em outubro",
      "Deal e proposta",
    );
    expect(appendToPageSection).toHaveBeenCalledWith(
      "new-partner-page-id",
      expect.stringContaining("Propôs um workshop conjunto."),
      "Log",
    );
  });

  it("enriches a newly-created influencer page: writes Kenko line + Sobre into Perfil e stats, appends Relação e histórico", async () => {
    fetchInstagramContactsWithMessages.mockResolvedValue([contact]);
    buildTranscript.mockReturnValue("Cliente: adorava experimentar uma aula e partilhar nos meus stories!");
    classifyInstagramDM.mockResolvedValue("influencer");
    extractVolunteeredEmail.mockReturnValue(null);
    findBestNameMatch.mockReturnValue({ name: "Joana F.", email: null, score: 0.7 });
    enrichInfluencerFromTranscript.mockResolvedValue({
      sobre: "Cria conteúdo de lifestyle",
      nicho: "lifestyle",
      tipoColaboracao: ["Visita ao estúdio"],
      status: "Em conversa",
      proximoPasso: "confirmar data da aula",
      log: "Propôs experimentar uma aula.",
    });

    await run();

    expect(replacePageSection).toHaveBeenCalledWith(
      "new-influencer-page-id",
      expect.stringContaining("Cria conteúdo de lifestyle"),
      "Perfil e stats",
    );
    const [, perfilContent] = replacePageSection.mock.calls[0]!;
    expect(perfilContent).toContain("Kenko: possível correspondência (nome semelhante a Joana F.)");
    expect(appendToPageSection).toHaveBeenCalledWith(
      "new-influencer-page-id",
      expect.stringContaining("Propôs experimentar uma aula."),
      "Relação e histórico",
    );
    expect(updateInfluencerFields).toHaveBeenCalledWith("new-influencer-page-id", {
      status: "Em conversa",
      tipoColaboracao: ["Visita ao estúdio"],
      nicho: "lifestyle",
      proximoPasso: "confirmar data da aula",
      ultimoContacto: "2026-01-01T00:00:00Z",
    });
  });

  it("a first-time enrichment failure never affects the checkpoint or fails the run", async () => {
    fetchInstagramContactsWithMessages.mockResolvedValue([contact]);
    buildTranscript.mockReturnValue("Cliente: adorava fazer uma parceria com a Haven!");
    classifyInstagramDM.mockResolvedValue("parceiro");
    enrichPartnerFromTranscript.mockRejectedValue(new Error("anthropic down"));

    await run();

    expect(createPartner).toHaveBeenCalled();
    expect((fsState as Record<string, { notionPageId: string | null }>)["contact-1"]?.notionPageId).toBe(
      "new-partner-page-id",
    );
  });

  it("re-enriches an existing partner page on new messages: full-transcript replace + delta-only Log entry", async () => {
    fsState = {
      "contact-1": {
        messageCountSeen: 1,
        classification: "parceiro",
        notionPageId: "existing-partner-page",
        classifiedAt: "x",
      },
    };
    const grownContact = {
      ...contact,
      messageCount: 3,
      messages: [
        { direction: "in" as const, text: "primeira mensagem", sentAt: "2026-01-01T00:00:00Z" },
        { direction: "out" as const, text: "resposta", sentAt: "2026-01-01T00:01:00Z" },
        { direction: "in" as const, text: "nova mensagem", sentAt: "2026-01-02T00:00:00Z" },
      ],
    };
    fetchInstagramContactsWithMessages.mockResolvedValue([grownContact]);
    buildTranscript.mockImplementation((messages: unknown[]) =>
      messages.length ? `transcript-of-${messages.length}-messages` : "",
    );
    enrichPartnerFromTranscript.mockResolvedValue({ sobre: "Sobre atualizado", deal: null, log: "ignorado aqui" });
    summarizeRelationshipUpdate.mockResolvedValue("Enviou uma nova mensagem a confirmar interesse.");

    await run();

    // full transcript (all 3 messages) used for the current-state replace
    expect(enrichPartnerFromTranscript).toHaveBeenCalledWith("transcript-of-3-messages");
    expect(replacePageSection).toHaveBeenCalledWith("existing-partner-page", "Sobre atualizado", "Sobre o parceiro");
    // only the DELTA (messages after index messageCountSeen=1, i.e. the last 2) goes into the update summary
    expect(summarizeRelationshipUpdate).toHaveBeenCalledWith("transcript-of-2-messages");
    expect(appendToPageSection).toHaveBeenCalledWith(
      "existing-partner-page",
      expect.stringContaining("Enviou uma nova mensagem a confirmar interesse."),
      "Log",
    );
    // never creates a second page
    expect(createPartner).not.toHaveBeenCalled();
    expect((fsState as Record<string, { messageCountSeen: number }>)["contact-1"]?.messageCountSeen).toBe(3);
  });

  it("re-enriches an existing influencer page: refreshes Status/Tipo/Nicho/Próximo passo/Último contacto from the full transcript", async () => {
    fsState = {
      "contact-1": {
        messageCountSeen: 1,
        classification: "influencer",
        notionPageId: "existing-influencer-page",
        classifiedAt: "x",
      },
    };
    const grownContact = {
      ...contact,
      messageCount: 3,
      lastMessageAt: "2026-02-05T10:00:00Z",
      messages: [
        { direction: "in" as const, text: "primeira mensagem", sentAt: "2026-01-01T00:00:00Z" },
        { direction: "out" as const, text: "resposta", sentAt: "2026-01-01T00:01:00Z" },
        { direction: "in" as const, text: "aceito!", sentAt: "2026-02-05T10:00:00Z" },
      ],
    };
    fetchInstagramContactsWithMessages.mockResolvedValue([grownContact]);
    buildTranscript.mockImplementation((messages: unknown[]) =>
      messages.length ? `transcript-of-${messages.length}-messages` : "",
    );
    extractVolunteeredEmail.mockReturnValue(null);
    enrichInfluencerFromTranscript.mockResolvedValue({
      sobre: "Sobre atualizado",
      nicho: "fitness",
      tipoColaboracao: ["Post patrocinado"],
      status: "Proposta enviada",
      proximoPasso: "aguardar confirmação",
      log: "ignorado aqui",
    });
    summarizeRelationshipUpdate.mockResolvedValue("Aceitou a proposta.");

    await run();

    expect(updateInfluencerFields).toHaveBeenCalledWith("existing-influencer-page", {
      status: "Proposta enviada",
      tipoColaboracao: ["Post patrocinado"],
      nicho: "fitness",
      proximoPasso: "aguardar confirmação",
      ultimoContacto: "2026-02-05T10:00:00Z",
    });
    expect(createInfluencer).not.toHaveBeenCalled();
  });

  it("leaves the checkpoint stale when re-enrichment fails, so the next run retries", async () => {
    fsState = {
      "contact-1": {
        messageCountSeen: 1,
        classification: "influencer",
        notionPageId: "existing-influencer-page",
        classifiedAt: "x",
      },
    };
    fetchInstagramContactsWithMessages.mockResolvedValue([contact]); // messageCount: 3
    buildTranscript.mockReturnValue("some transcript");
    enrichInfluencerFromTranscript.mockRejectedValue(new Error("anthropic down"));

    await run();

    expect((fsState as Record<string, { messageCountSeen: number }>)["contact-1"]?.messageCountSeen).toBe(1);
  });

  it("does not re-enrich a cliente/nenhum checkpoint entry, just refreshes the message count", async () => {
    fsState = {
      "contact-1": { messageCountSeen: 1, classification: "nenhum", notionPageId: "existing-page", classifiedAt: "x" },
    };
    fetchInstagramContactsWithMessages.mockResolvedValue([contact]); // messageCount: 3

    await run();

    expect(enrichPartnerFromTranscript).not.toHaveBeenCalled();
    expect(enrichInfluencerFromTranscript).not.toHaveBeenCalled();
    expect(summarizeRelationshipUpdate).not.toHaveBeenCalled();
    expect((fsState as Record<string, { messageCountSeen: number }>)["contact-1"]?.messageCountSeen).toBe(3);
  });
});
