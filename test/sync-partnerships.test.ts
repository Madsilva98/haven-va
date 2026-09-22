import crypto from "node:crypto";
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

const enrichPartnerPageFromText = vi.fn().mockResolvedValue(undefined);
const enrichInfluencerPageFromText = vi.fn().mockResolvedValue(undefined);
const enrichSupplierPageFromText = vi.fn().mockResolvedValue(undefined);
vi.mock("../src/lib/entity-enrichment.js", () => ({
  enrichPartnerPageFromText: (...args: unknown[]) => enrichPartnerPageFromText(...args),
  enrichInfluencerPageFromText: (...args: unknown[]) => enrichInfluencerPageFromText(...args),
  enrichSupplierPageFromText: (...args: unknown[]) => enrichSupplierPageFromText(...args),
}));

const classifyPartnershipEmailIntent = vi.fn();
vi.mock("../src/lib/lead-classifier.js", () => ({
  classifyPartnershipEmailIntent: (...args: unknown[]) => classifyPartnershipEmailIntent(...args),
}));

const isAuthenticated = vi.fn().mockReturnValue(true);
const getMyEmail = vi.fn().mockResolvedValue("madalena@thehavenpilates.pt");
const searchMailboxMessages = vi.fn();
const forwardMessage = vi.fn().mockResolvedValue(undefined);
const archiveMessage = vi.fn().mockResolvedValue(undefined);
vi.mock("../src/lib/outlook.js", () => ({
  isAuthenticated: () => isAuthenticated(),
  getMyEmail: (...args: unknown[]) => getMyEmail(...args),
  searchMailboxMessages: (...args: unknown[]) => searchMailboxMessages(...args),
  forwardMessage: (...args: unknown[]) => forwardMessage(...args),
  archiveMessage: (...args: unknown[]) => archiveMessage(...args),
}));

const getAllPartnerContacts = vi.fn().mockResolvedValue([]);
const getAllInfluencerContacts = vi.fn().mockResolvedValue([]);
const getAllSupplierContacts = vi.fn().mockResolvedValue([]);
const findPageInDb = vi.fn().mockResolvedValue(null);
const createPartner = vi.fn().mockResolvedValue("new-partner-id");
const createInfluencer = vi.fn().mockResolvedValue("new-influencer-id");
const createSupplier = vi.fn().mockResolvedValue("new-supplier-id");
const updatePartnerFields = vi.fn().mockResolvedValue(undefined);
const updateInfluencerFields = vi.fn().mockResolvedValue(undefined);
const updateSupplierFields = vi.fn().mockResolvedValue(undefined);
vi.mock("../src/notion.js", () => ({
  getAllPartnerContacts: (...args: unknown[]) => getAllPartnerContacts(...args),
  getAllInfluencerContacts: (...args: unknown[]) => getAllInfluencerContacts(...args),
  getAllSupplierContacts: (...args: unknown[]) => getAllSupplierContacts(...args),
  findPageInDb: (...args: unknown[]) => findPageInDb(...args),
  createPartner: (...args: unknown[]) => createPartner(...args),
  createInfluencer: (...args: unknown[]) => createInfluencer(...args),
  createSupplier: (...args: unknown[]) => createSupplier(...args),
  updatePartnerFields: (...args: unknown[]) => updatePartnerFields(...args),
  updateInfluencerFields: (...args: unknown[]) => updateInfluencerFields(...args),
  updateSupplierFields: (...args: unknown[]) => updateSupplierFields(...args),
}));

import { run } from "../src/crons/sync-partnerships.js";

function makeMessage(overrides: Partial<{
  id: string;
  mailbox: string;
  subject: string;
  from: { name: string; email: string };
  to: { name: string; email: string }[];
  receivedDateTime: string;
  body: string;
}> = {}) {
  return {
    id: overrides.id ?? "msg-1",
    mailbox: overrides.mailbox ?? "me",
    subject: overrides.subject ?? "Proposta de colaboração",
    from: overrides.from ?? { name: "Wanderlust Studio", email: "geral@wanderlust.pt" },
    to: overrides.to ?? [{ name: "Haven", email: "madalena@thehavenpilates.pt" }],
    receivedDateTime: overrides.receivedDateTime ?? "2026-09-20T10:00:00.000Z",
    bodyPreview: "",
    body: overrides.body ?? "Gostávamos de propor um workshop conjunto.",
    webLink: "https://outlook.office.com/mail/msg-1",
    hasAttachments: false,
    categories: [],
    isRead: true,
    lastModifiedDateTime: overrides.receivedDateTime ?? "2026-09-20T10:00:00.000Z",
    conversationId: "conv-1",
    sentDateTime: overrides.receivedDateTime ?? "2026-09-20T10:00:00.000Z",
    parentFolderId: "inbox",
  };
}

describe("sync-partnerships", () => {
  beforeEach(() => {
    process.env.NOTION_PARTNER_DB_ID = "test-partner-db";
    process.env.NOTION_INFLUENCER_DB_ID = "test-influencer-db";
    delete process.env.NOTION_SUPPLIER_DB_ID;
    delete process.env.OUTLOOK_MAILBOXES;
    delete process.env.OUTLOOK_PARTNERSHIP_FORWARD_TO;
    fsState = null;
  });

  afterEach(() => {
    delete process.env.NOTION_PARTNER_DB_ID;
    delete process.env.NOTION_INFLUENCER_DB_ID;
    delete process.env.NOTION_SUPPLIER_DB_ID;
    delete process.env.OUTLOOK_MAILBOXES;
    delete process.env.OUTLOOK_PARTNERSHIP_FORWARD_TO;
    enrichPartnerPageFromText.mockClear();
    enrichInfluencerPageFromText.mockClear();
    enrichSupplierPageFromText.mockClear();
    classifyPartnershipEmailIntent.mockReset();
    isAuthenticated.mockReset().mockReturnValue(true);
    getMyEmail.mockReset().mockResolvedValue("madalena@thehavenpilates.pt");
    searchMailboxMessages.mockReset();
    forwardMessage.mockClear();
    archiveMessage.mockClear();
    getAllPartnerContacts.mockReset().mockResolvedValue([]);
    getAllInfluencerContacts.mockReset().mockResolvedValue([]);
    getAllSupplierContacts.mockReset().mockResolvedValue([]);
    findPageInDb.mockReset().mockResolvedValue(null);
    createPartner.mockClear().mockResolvedValue("new-partner-id");
    createInfluencer.mockClear().mockResolvedValue("new-influencer-id");
    createSupplier.mockClear().mockResolvedValue("new-supplier-id");
    updatePartnerFields.mockClear().mockResolvedValue(undefined);
    updateInfluencerFields.mockClear().mockResolvedValue(undefined);
    updateSupplierFields.mockClear().mockResolvedValue(undefined);
    readFileSync.mockClear();
    writeFileSync.mockClear();
  });

  it("does nothing when the pipeline DBs aren't configured", async () => {
    delete process.env.NOTION_INFLUENCER_DB_ID;
    await run();
    expect(searchMailboxMessages).not.toHaveBeenCalled();
  });

  it("does nothing when Outlook isn't authenticated", async () => {
    isAuthenticated.mockReturnValue(false);
    await run();
    expect(searchMailboxMessages).not.toHaveBeenCalled();
  });

  it("creates a new Partner Pipeline row for a brand-new partnership email", async () => {
    searchMailboxMessages.mockResolvedValue([makeMessage()]);
    classifyPartnershipEmailIntent.mockResolvedValue("parceiro");

    await run();

    expect(createPartner).toHaveBeenCalledWith(
      "Wanderlust Studio",
      "Unassigned",
      expect.any(String),
      "Parceria",
      "A contactar",
      "2026-09-20T10:00:00.000Z",
    );
    expect(updatePartnerFields).toHaveBeenCalledWith("new-partner-id", { email: "geral@wanderlust.pt" });
    expect(enrichPartnerPageFromText).toHaveBeenCalledWith("new-partner-id", expect.stringContaining("workshop conjunto"));
    expect(createInfluencer).not.toHaveBeenCalled();
  });

  it("creates a new Influencer Pipeline row for a brand-new influencer email", async () => {
    searchMailboxMessages.mockResolvedValue([
      makeMessage({ subject: "Colaboração de conteúdo", body: "Adorava experimentar uma aula e postar nos meus stories." }),
    ]);
    classifyPartnershipEmailIntent.mockResolvedValue("influencer");

    await run();

    expect(createInfluencer).toHaveBeenCalledWith(
      "Wanderlust Studio",
      "Unassigned",
      expect.any(String),
      "Email",
      "2026-09-20T10:00:00.000Z",
      "A contactar",
      "geral@wanderlust.pt",
    );
    expect(createPartner).not.toHaveBeenCalled();
  });

  it("creates a new Fornecedores row for a brand-new vendor sales pitch, when the DB is configured", async () => {
    process.env.NOTION_SUPPLIER_DB_ID = "test-supplier-db";
    searchMailboxMessages.mockResolvedValue([
      makeMessage({ subject: "Equipamento de Pilates com desconto", body: "Vendemos reformers e acessórios com condições especiais." }),
    ]);
    classifyPartnershipEmailIntent.mockResolvedValue("fornecedor");

    await run();

    expect(createSupplier).toHaveBeenCalledWith(
      "Wanderlust Studio",
      "Unassigned",
      expect.any(String),
      "Email",
      "2026-09-20T10:00:00.000Z",
      "A avaliar",
      "geral@wanderlust.pt",
    );
    expect(enrichSupplierPageFromText).toHaveBeenCalledWith("new-supplier-id", expect.stringContaining("reformers"));
    expect(createPartner).not.toHaveBeenCalled();
    expect(createInfluencer).not.toHaveBeenCalled();
  });

  it("skips a fornecedor classification gracefully when NOTION_SUPPLIER_DB_ID isn't set, never calling createSupplier", async () => {
    searchMailboxMessages.mockResolvedValue([makeMessage()]);
    classifyPartnershipEmailIntent.mockResolvedValue("fornecedor");

    await run();

    expect(createSupplier).not.toHaveBeenCalled();
    expect(enrichSupplierPageFromText).not.toHaveBeenCalled();
    expect(findPageInDb).not.toHaveBeenCalled();
  });

  it("auto-updates an existing supplier on an exact email match, skipping the classifier entirely", async () => {
    process.env.NOTION_SUPPLIER_DB_ID = "test-supplier-db";
    getAllSupplierContacts.mockResolvedValue([
      { id: "existing-supplier-id", name: "Kapta", email: "geral@wanderlust.pt" },
    ]);
    searchMailboxMessages.mockResolvedValue([makeMessage()]);

    await run();

    expect(classifyPartnershipEmailIntent).not.toHaveBeenCalled();
    expect(createSupplier).not.toHaveBeenCalled();
    expect(updateSupplierFields).toHaveBeenCalledWith("existing-supplier-id", { ultimoContacto: "2026-09-20T10:00:00.000Z" });
    expect(enrichSupplierPageFromText).toHaveBeenCalledWith("existing-supplier-id", expect.any(String));
  });

  it("skips creating a supplier when a fuzzy name match already exists (dedup)", async () => {
    process.env.NOTION_SUPPLIER_DB_ID = "test-supplier-db";
    searchMailboxMessages.mockResolvedValue([makeMessage()]);
    classifyPartnershipEmailIntent.mockResolvedValue("fornecedor");
    findPageInDb.mockResolvedValue({ id: "already-there", title: "Wanderlust Fornecimentos" });

    await run();

    expect(createSupplier).not.toHaveBeenCalled();
    expect(updateSupplierFields).not.toHaveBeenCalled();
    expect(enrichSupplierPageFromText).not.toHaveBeenCalled();
  });

  it("writes nothing for a message classified as nenhum", async () => {
    searchMailboxMessages.mockResolvedValue([makeMessage()]);
    classifyPartnershipEmailIntent.mockResolvedValue("nenhum");

    await run();

    expect(createPartner).not.toHaveBeenCalled();
    expect(createInfluencer).not.toHaveBeenCalled();
  });

  it("skips creation for an internal-only forward with no external recipient, never guessing the sender's own name as the partner", async () => {
    // A founder forwarding a partnership email to the rest of the team —
    // sender AND every recipient are on the Haven's own domain, so there is
    // no external party to name a page after. Regression for a real
    // incident (2026-09-22): the pre-fix fallback used the sender's own
    // name ("Madalena Marques Da Silva") as the guessed partner name,
    // which would have silently created a Partner Pipeline page titled
    // after a founder instead of the actual partner.
    searchMailboxMessages.mockResolvedValue([
      makeMessage({
        from: { name: "Madalena Marques Da Silva", email: "madalena@thehavenpilates.pt" },
        to: [
          { name: "Mafalda Saudade", email: "mafalda@thehavenpilates.pt" },
          { name: "Beatriz Rogério", email: "beatriz@thehavenpilates.pt" },
        ],
      }),
    ]);
    classifyPartnershipEmailIntent.mockResolvedValue("parceiro");

    await run();

    expect(createPartner).not.toHaveBeenCalled();
    expect(createInfluencer).not.toHaveBeenCalled();
    expect(findPageInDb).not.toHaveBeenCalled();
    expect(enrichPartnerPageFromText).not.toHaveBeenCalled();
  });

  it("auto-updates an existing partner on an exact email match, skipping the classifier entirely", async () => {
    getAllPartnerContacts.mockResolvedValue([
      { id: "existing-partner-id", name: "Wanderlust Studio", email: "geral@wanderlust.pt" },
    ]);
    searchMailboxMessages.mockResolvedValue([makeMessage()]);

    await run();

    expect(classifyPartnershipEmailIntent).not.toHaveBeenCalled();
    expect(createPartner).not.toHaveBeenCalled();
    expect(updatePartnerFields).toHaveBeenCalledWith("existing-partner-id", { ultimoContacto: "2026-09-20T10:00:00.000Z" });
    expect(enrichPartnerPageFromText).toHaveBeenCalledWith("existing-partner-id", expect.any(String));
  });

  it("skips creation when a fuzzy name match already exists (dedup), never touching that page", async () => {
    searchMailboxMessages.mockResolvedValue([makeMessage()]);
    classifyPartnershipEmailIntent.mockResolvedValue("parceiro");
    findPageInDb.mockResolvedValue({ id: "already-there", title: "Wanderlust_Portugal" });

    await run();

    expect(createPartner).not.toHaveBeenCalled();
    expect(updatePartnerFields).not.toHaveBeenCalled();
    expect(enrichPartnerPageFromText).not.toHaveBeenCalled();
  });

  it("forwards and archives the source email when OUTLOOK_PARTNERSHIP_FORWARD_TO is set", async () => {
    process.env.OUTLOOK_PARTNERSHIP_FORWARD_TO = "parcerias@thehavenpilates.pt";
    searchMailboxMessages.mockResolvedValue([makeMessage()]);
    classifyPartnershipEmailIntent.mockResolvedValue("parceiro");

    await run();

    expect(forwardMessage).toHaveBeenCalledWith(
      "me",
      "msg-1",
      ["parcerias@thehavenpilates.pt"],
      expect.any(String),
    );
    expect(archiveMessage).toHaveBeenCalledWith("me", "msg-1");
  });

  it("never forwards/archives when OUTLOOK_PARTNERSHIP_FORWARD_TO isn't set", async () => {
    searchMailboxMessages.mockResolvedValue([makeMessage()]);
    classifyPartnershipEmailIntent.mockResolvedValue("parceiro");

    await run();

    expect(forwardMessage).not.toHaveBeenCalled();
    expect(archiveMessage).not.toHaveBeenCalled();
  });

  it("scans full history on first run (no watermark), then persists one for next time", async () => {
    searchMailboxMessages.mockResolvedValue([makeMessage()]);
    classifyPartnershipEmailIntent.mockResolvedValue("nenhum");

    await run();

    expect(searchMailboxMessages).toHaveBeenCalledWith("me", { sinceISO: undefined });
    expect(fsState).toBeTruthy();
    const saved = fsState as { mailboxWatermarks: Record<string, string> };
    expect(saved.mailboxWatermarks.me).toBe("2026-09-20T10:00:00.000Z");
  });

  it("never reprocesses a message already checkpointed, even if the watermark re-includes it", async () => {
    fsState = {
      mailboxWatermarks: { me: "2026-09-19T00:00:00.000Z" },
      messages: {
        // findingId("me", "msg-1") — precomputed so this fixture is already "seen".
        [crypto.createHash("sha256").update("me:msg-1").digest("hex").slice(0, 12)]: {
          classification: "nenhum",
          matchBasis: null,
          pipeline: null,
          notionPageId: null,
          processedAt: "2026-09-19T00:00:00.000Z",
        },
      },
    };
    searchMailboxMessages.mockResolvedValue([makeMessage()]);

    await run();

    expect(classifyPartnershipEmailIntent).not.toHaveBeenCalled();
    expect(createPartner).not.toHaveBeenCalled();
  });

  it("includes every configured mailbox plus 'me'", async () => {
    process.env.OUTLOOK_MAILBOXES = "partners@thehavenpilates.pt,mafalda@thehavenpilates.pt";
    searchMailboxMessages.mockResolvedValue([]);

    await run();

    expect(searchMailboxMessages).toHaveBeenCalledWith("me", expect.anything());
    expect(searchMailboxMessages).toHaveBeenCalledWith("partners@thehavenpilates.pt", expect.anything());
    expect(searchMailboxMessages).toHaveBeenCalledWith("mafalda@thehavenpilates.pt", expect.anything());
  });
});
