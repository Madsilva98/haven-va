import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { OutlookMessage } from "../src/lib/outlook.js";

// ── in-memory files (state + legacy sync state) ─────────────────────────
const files = vi.hoisted(() => new Map<string, string>());
const baseName = (p: string) => p.split(/[\\/]/).pop()!;
vi.mock("node:fs", () => {
  const api = {
    readFileSync: (p: string) => {
      const v = files.get(baseName(String(p)));
      if (v === undefined) throw new Error("ENOENT");
      return v;
    },
    writeFileSync: (p: string, data: string) => void files.set(baseName(String(p)), data),
    mkdirSync: () => undefined,
  };
  return { default: api, ...api };
});

const outlookMock = vi.hoisted(() => ({
  isAuthenticated: vi.fn().mockReturnValue(true),
  getMyEmail: vi.fn().mockResolvedValue("madalena@thehavenpilates.pt"),
  searchMailboxMessages: vi.fn(),
  listInboxMessages: vi.fn(),
  listSentMessages: vi.fn(),
  getMessageAttachments: vi.fn(),
  setMessageCategories: vi.fn(),
  forwardMessage: vi.fn(),
  archiveMessage: vi.fn(),
}));
vi.mock("../src/lib/outlook.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/outlook.js")>();
  return { ...outlookMock, isKeptInInbox: actual.isKeptInInbox, keptConversationIds: actual.keptConversationIds };
});

const classifyMail = vi.fn();
vi.mock("../src/lib/mail-verdict.js", () => ({ classifyMail: (...a: unknown[]) => classifyMail(...a) }));

const enrichment = vi.hoisted(() => ({
  enrichPartnerPageFromText: vi.fn(),
  enrichInfluencerPageFromText: vi.fn(),
  enrichSupplierPageFromText: vi.fn(),
}));
vi.mock("../src/lib/entity-enrichment.js", () => enrichment);

const notionMock = vi.hoisted(() => ({
  getAllPartnerContacts: vi.fn(),
  getAllInfluencerContacts: vi.fn(),
  getAllSupplierContacts: vi.fn(),
  findPageInDb: vi.fn(),
  createPartner: vi.fn(),
  createInfluencer: vi.fn(),
  createSupplier: vi.fn(),
  updatePartnerFields: vi.fn(),
  updateSupplierFields: vi.fn(),
}));
vi.mock("../src/notion.js", () => notionMock);

import { messageKey, run } from "../src/crons/mail-triage.js";

const GERAL = "geral@thehavenpilates.pt";
const PERSONAL = "mafalda@thehavenpilates.pt";
const T = {
  partners: "partners@thehavenpilates.pt",
  suppliers: GERAL,
  staff: "staff@thehavenpilates.pt",
  invoices: "faturas@thehavenpilates.pt",
};

function msg(o: Partial<OutlookMessage> = {}): OutlookMessage {
  return {
    id: "m1",
    mailbox: GERAL,
    subject: "Proposta de colaboração",
    from: { name: "Wanderlust Studio", email: "ola@wanderlust.pt" },
    to: [{ name: "Haven", email: GERAL }],
    receivedDateTime: "2026-09-29T10:00:00Z",
    bodyPreview: "",
    body: "Gostávamos de propor um workshop conjunto.",
    webLink: "",
    hasAttachments: false,
    categories: [],
    isRead: true,
    lastModifiedDateTime: "2026-09-29T10:00:00Z",
    conversationId: "c1",
    sentDateTime: "2026-09-29T10:00:00Z",
    parentFolderId: "inbox",
    ...o,
  };
}

const verdict = (o: Partial<{ tipo: string; needsAction: boolean; isSupplierInvoice: boolean }> = {}) => ({
  tipo: "outro",
  needsAction: true,
  isSupplierInvoice: false,
  reason: "r",
  ...o,
});

/** Mailbox → messages; in a clean mailbox the same messages are also the Inbox. */
function mailboxes(recent: Record<string, OutlookMessage[]>, inbox: Record<string, OutlookMessage[]> = recent) {
  outlookMock.searchMailboxMessages.mockImplementation(async (mb: string) => recent[mb] ?? []);
  outlookMock.listInboxMessages.mockImplementation(async (mb: string) => inbox[mb] ?? []);
}

function state() {
  return JSON.parse(files.get("mail-triage-state.json") ?? "{}");
}

beforeEach(() => {
  files.clear();
  // Went live before the test messages arrived, so forwards apply.
  files.set("mail-triage-state.json", JSON.stringify({ forwardSince: "2026-01-01T00:00:00Z", mailboxWatermarks: {}, messages: {} }));
  process.env.OUTLOOK_TIDY_MAILBOXES = GERAL;
  process.env.OUTLOOK_MAILBOXES = `${GERAL},${PERSONAL}`;
  process.env.OUTLOOK_PARTNERSHIP_FORWARD_TO = T.partners;
  process.env.OUTLOOK_SUPPLIERS_FORWARD_TO = T.suppliers;
  process.env.OUTLOOK_STAFF_FORWARD_TO = T.staff;
  process.env.OUTLOOK_INVOICES_FORWARD_TO = T.invoices;
  process.env.NOTION_PARTNER_DB_ID = "p";
  process.env.NOTION_INFLUENCER_DB_ID = "i";
  process.env.NOTION_SUPPLIER_DB_ID = "s";
  outlookMock.isAuthenticated.mockReturnValue(true);
  outlookMock.getMyEmail.mockResolvedValue("madalena@thehavenpilates.pt");
  outlookMock.listSentMessages.mockResolvedValue([]);
  outlookMock.getMessageAttachments.mockResolvedValue([]);
  outlookMock.setMessageCategories.mockResolvedValue(undefined);
  outlookMock.forwardMessage.mockResolvedValue(undefined);
  outlookMock.archiveMessage.mockResolvedValue(undefined);
  notionMock.getAllPartnerContacts.mockResolvedValue([]);
  notionMock.getAllInfluencerContacts.mockResolvedValue([]);
  notionMock.getAllSupplierContacts.mockResolvedValue([]);
  notionMock.findPageInDb.mockResolvedValue(null);
  notionMock.createPartner.mockResolvedValue("new-partner");
  notionMock.createInfluencer.mockResolvedValue("new-influencer");
  notionMock.createSupplier.mockResolvedValue("new-supplier");
  notionMock.updatePartnerFields.mockResolvedValue(undefined);
  notionMock.updateSupplierFields.mockResolvedValue(undefined);
  mailboxes({});
});

afterEach(() => {
  vi.clearAllMocks();
  delete process.env.MAIL_TRIAGE_DRY_RUN;
  delete process.env.TIDY_MAILBOXES_MAX_ARCHIVES_PER_RUN;
});

describe("mail-triage: record → forward → clean, one pass", () => {
  it("records a partner in Notion BEFORE archiving it, and forwards it to partners@ — one AI call", async () => {
    mailboxes({ [GERAL]: [msg()] });
    classifyMail.mockResolvedValue(verdict({ tipo: "parceiro", needsAction: false }));

    await run();

    expect(classifyMail).toHaveBeenCalledTimes(1);
    expect(notionMock.createPartner).toHaveBeenCalledTimes(1);
    expect(outlookMock.forwardMessage).toHaveBeenCalledWith(GERAL, "m1", [T.partners], expect.stringContaining("parceria"));
    expect(outlookMock.archiveMessage).toHaveBeenCalledWith(GERAL, "m1");
    expect(notionMock.createPartner.mock.invocationCallOrder[0]!).toBeLessThan(
      outlookMock.archiveMessage.mock.invocationCallOrder[0]!,
    );
  });

  it("forwards each email at most once — a second run doesn't repeat it", async () => {
    mailboxes({ [GERAL]: [msg()] });
    classifyMail.mockResolvedValue(verdict({ tipo: "parceiro", needsAction: true }));

    await run();
    await run();

    expect(outlookMock.forwardMessage).toHaveBeenCalledTimes(1);
    expect(notionMock.createPartner).toHaveBeenCalledTimes(1);
  });

  it("instructor application: forwarded to staff, never recorded in Notion", async () => {
    mailboxes({ [GERAL]: [msg({ subject: "Candidatura instrutora de pilates", from: { name: "Ana", email: "ana@gmail.com" } })] });
    classifyMail.mockResolvedValue(verdict({ tipo: "candidatura" }));

    await run();

    expect(outlookMock.forwardMessage).toHaveBeenCalledWith(GERAL, "m1", [T.staff], expect.stringContaining("candidatura"));
    expect(notionMock.createPartner).not.toHaveBeenCalled();
    expect(notionMock.createSupplier).not.toHaveBeenCalled();
  });

  it("supplier in a personal mailbox → recorded AND forwarded to geral@; in geral@ itself → recorded only", async () => {
    const personal = msg({ id: "p1", mailbox: PERSONAL, from: { name: "Lipclean", email: "lipclean.trans@gmail.com" }, to: [{ name: "Mafalda", email: PERSONAL }] });
    const shared = msg({ id: "g1", from: { name: "Stages", email: "sales@stagescycling.com" } });
    mailboxes({ [PERSONAL]: [personal], [GERAL]: [shared] }, { [GERAL]: [shared] });
    classifyMail.mockResolvedValue(verdict({ tipo: "fornecedor" }));

    await run();

    expect(notionMock.createSupplier).toHaveBeenCalledTimes(2);
    expect(outlookMock.forwardMessage).toHaveBeenCalledTimes(1);
    expect(outlookMock.forwardMessage).toHaveBeenCalledWith(PERSONAL, "p1", [GERAL], expect.any(String));
  });

  it("never forwards the backlog from before go-live, or mail the Haven itself sent", async () => {
    files.set("mail-triage-state.json", JSON.stringify({ forwardSince: "2026-09-30T00:00:00Z", mailboxWatermarks: {}, messages: {} }));
    mailboxes({
      [GERAL]: [
        msg({ id: "old", receivedDateTime: "2026-09-29T10:00:00Z" }),
        msg({ id: "ours", receivedDateTime: "2026-10-01T10:00:00Z", from: { name: "Madalena", email: "madalena@thehavenpilates.pt" } }),
      ],
    });
    classifyMail.mockResolvedValue(verdict({ tipo: "parceiro" }));

    await run();

    expect(outlookMock.forwardMessage).not.toHaveBeenCalled();
  });

  it("records an unread email but never archives it", async () => {
    mailboxes({ [GERAL]: [msg({ isRead: false })] });
    classifyMail.mockResolvedValue(verdict({ tipo: "parceiro", needsAction: false }));

    await run();

    expect(notionMock.createPartner).toHaveBeenCalledTimes(1);
    expect(outlookMock.archiveMessage).not.toHaveBeenCalled();
  });

  it("personal mailboxes are never cleaned", async () => {
    mailboxes({ [PERSONAL]: [msg({ mailbox: PERSONAL })] }, {});
    classifyMail.mockResolvedValue(verdict({ tipo: "outro", needsAction: false }));

    await run();

    expect(outlookMock.archiveMessage).not.toHaveBeenCalled();
    expect(outlookMock.listInboxMessages).not.toHaveBeenCalledWith(PERSONAL);
  });

  it("known contact (exact email) in a personal box is updated without any AI call", async () => {
    notionMock.getAllSupplierContacts.mockResolvedValue([
      { id: "stages", name: "Stages Cycling / Fit4Life Portugal", email: "sales@stagescycling.com" },
    ]);
    mailboxes({ [PERSONAL]: [msg({ mailbox: PERSONAL, from: { name: "Stages", email: "sales@stagescycling.com" }, to: [{ name: "M", email: PERSONAL }] })] }, {});

    await run();

    expect(classifyMail).not.toHaveBeenCalled();
    expect(notionMock.updateSupplierFields).toHaveBeenCalledWith("stages", expect.anything());
    expect(outlookMock.forwardMessage).toHaveBeenCalledWith(PERSONAL, "m1", [GERAL], expect.any(String));
  });

  it("undecided AI answer: nothing recorded, forwarded or archived, and the watermark stops at it", async () => {
    mailboxes({
      [GERAL]: [
        msg({ id: "undecided", conversationId: "cu", body: "undecided", receivedDateTime: "2026-09-28T10:00:00Z" }),
        msg({ id: "fine", conversationId: "cf", receivedDateTime: "2026-09-29T10:00:00Z" }),
      ],
    });
    classifyMail.mockImplementation(async (input: { body: string }) =>
      input.body === "undecided" ? null : verdict({ tipo: "parceiro", needsAction: false }),
    );

    await run();

    expect(outlookMock.archiveMessage).not.toHaveBeenCalledWith(GERAL, "undecided");
    expect(outlookMock.forwardMessage).not.toHaveBeenCalledWith(GERAL, "undecided", expect.anything(), expect.anything());
    // Held at the undecided email's date, not advanced past it, so the next run retries it.
    expect(state().mailboxWatermarks[GERAL]).toBe("2026-09-28T10:00:00Z");
  });

  it("migrates the old sync-partnerships checkpoint: already-recorded mail isn't redone", async () => {
    files.delete("mail-triage-state.json");
    files.set(
      "partnerships-sync-state.json",
      JSON.stringify({
        mailboxWatermarks: { [PERSONAL]: "2026-09-28T00:00:00Z" },
        messages: { [messageKey(PERSONAL, "m1")]: { classification: "parceiro", pipeline: "partners", notionPageId: "x", processedAt: "2026-09-28T00:00:00Z" } },
      }),
    );
    mailboxes({ [PERSONAL]: [msg({ mailbox: PERSONAL })] }, {});

    await run();

    expect(outlookMock.searchMailboxMessages).toHaveBeenCalledWith(PERSONAL, { sinceISO: "2026-09-28T00:00:00Z" });
    expect(classifyMail).not.toHaveBeenCalled();
    expect(notionMock.createPartner).not.toHaveBeenCalled();
  });
});

describe("mail-triage: recording rules carried over from sync-partnerships", () => {
  it("dedup: a fuzzy name match skips creation, never touches that page", async () => {
    notionMock.findPageInDb.mockResolvedValue({ id: "existing", title: "Wanderlust" });
    mailboxes({ [PERSONAL]: [msg({ mailbox: PERSONAL, to: [{ name: "M", email: PERSONAL }] })] }, {});
    classifyMail.mockResolvedValue(verdict({ tipo: "parceiro" }));

    await run();

    expect(notionMock.createPartner).not.toHaveBeenCalled();
    expect(notionMock.updatePartnerFields).not.toHaveBeenCalled();
  });

  it("an internal-only forward (a founder re-sharing a thread) never creates a page named after a founder", async () => {
    mailboxes(
      {
        [PERSONAL]: [
          msg({
            mailbox: PERSONAL,
            from: { name: "Madalena Marques Da Silva", email: "madalena@thehavenpilates.pt" },
            to: [{ name: "Mafalda", email: PERSONAL }],
          }),
        ],
      },
      {},
    );
    classifyMail.mockResolvedValue(verdict({ tipo: "parceiro" }));

    await run();

    expect(notionMock.createPartner).not.toHaveBeenCalled();
  });

  it("fornecedor is skipped gracefully when the Fornecedores DB isn't configured", async () => {
    delete process.env.NOTION_SUPPLIER_DB_ID;
    mailboxes({ [PERSONAL]: [msg({ mailbox: PERSONAL, to: [{ name: "M", email: PERSONAL }] })] }, {});
    classifyMail.mockResolvedValue(verdict({ tipo: "fornecedor" }));

    await run();

    expect(notionMock.createSupplier).not.toHaveBeenCalled();
    expect(state().messages[messageKey(PERSONAL, "m1")].recorded).toBe(true);
  });

  it("a domain-only match is a dedup hint, never an automatic update", async () => {
    notionMock.getAllPartnerContacts.mockResolvedValue([{ id: "wl", name: "Wanderlust", email: "geral@wanderlust.pt" }]);
    mailboxes({ [PERSONAL]: [msg({ mailbox: PERSONAL, to: [{ name: "M", email: PERSONAL }] })] }, {}); // from ola@wanderlust.pt
    classifyMail.mockResolvedValue(verdict({ tipo: "parceiro" }));

    await run();

    expect(classifyMail).toHaveBeenCalled(); // not treated as a certain known contact
    expect(notionMock.updatePartnerFields).not.toHaveBeenCalled();
    expect(notionMock.createPartner).not.toHaveBeenCalled();
  });
});

describe("mail-triage: cleaning fail-safes carried over from tidy-mailboxes", () => {
  it("'não arquivar' protects the whole thread from archiving (recording still happens)", async () => {
    mailboxes({
      [GERAL]: [
        msg({ id: "orig", conversationId: "fit4life", categories: ["TidyBot: não arquivar"] }),
        msg({ id: "reply", conversationId: "fit4life" }),
      ],
    });
    classifyMail.mockResolvedValue(verdict({ tipo: "fornecedor", needsAction: false }));

    await run();

    expect(outlookMock.archiveMessage).not.toHaveBeenCalled();
    expect(notionMock.createSupplier).toHaveBeenCalled();
  });

  it("'devia ter arquivado' archives straight away, but 'não arquivar' wins if both", async () => {
    mailboxes({
      [GERAL]: [
        msg({ id: "a", conversationId: "ca", categories: ["TidyBot: devia ter arquivado"] }),
        msg({ id: "b", conversationId: "cb", categories: ["TidyBot: devia ter arquivado", "TidyBot: não arquivar"] }),
      ],
    });
    classifyMail.mockResolvedValue(verdict({ needsAction: true }));

    await run();

    expect(outlookMock.archiveMessage).toHaveBeenCalledTimes(1);
    expect(outlookMock.archiveMessage).toHaveBeenCalledWith(GERAL, "a");
  });

  it("known noise senders are archived with no AI call", async () => {
    mailboxes({ [GERAL]: [msg({ from: { name: "CTT", email: "no-reply@cttexpresso.pt" } })] });

    await run();

    expect(classifyMail).not.toHaveBeenCalled();
    expect(outlookMock.archiveMessage).toHaveBeenCalledWith(GERAL, "m1");
  });

  it("needs action → left in the Inbox, tagged 'revisto', and not re-classified next run", async () => {
    mailboxes({ [GERAL]: [msg()] });
    classifyMail.mockResolvedValue(verdict({ needsAction: true }));

    await run();
    await run();

    expect(outlookMock.archiveMessage).not.toHaveBeenCalled();
    expect(outlookMock.setMessageCategories).toHaveBeenCalledWith(GERAL, "m1", ["TidyBot: revisto"]);
    expect(classifyMail).toHaveBeenCalledTimes(1);
  });

  it("a newer Haven reply in Sent Items re-triggers the verdict, judged on that reply", async () => {
    mailboxes({ [GERAL]: [msg()] });
    classifyMail.mockResolvedValueOnce(verdict({ needsAction: true }));
    await run();

    outlookMock.listSentMessages.mockResolvedValue([
      msg({ id: "s1", body: "Já está resolvido, obrigada!", sentDateTime: "2026-09-30T09:00:00Z", from: { name: "Haven", email: GERAL } }),
    ]);
    classifyMail.mockResolvedValueOnce(verdict({ needsAction: false }));
    await run();

    expect(classifyMail).toHaveBeenLastCalledWith(expect.objectContaining({ laterReplyBody: "Já está resolvido, obrigada!" }));
    expect(outlookMock.archiveMessage).toHaveBeenCalledWith(GERAL, "m1");
  });

  it("our own auto-forward in Sent Items is not mistaken for a reply", async () => {
    outlookMock.listSentMessages.mockResolvedValue([
      msg({ id: "fw", body: "Reencaminhado automaticamente (parceria).", sentDateTime: "2026-09-30T09:00:00Z", to: [{ name: "", email: T.partners }] }),
    ]);
    mailboxes({ [GERAL]: [msg()] });
    classifyMail.mockResolvedValue(verdict({ needsAction: true }));

    await run();

    expect(classifyMail).toHaveBeenCalledWith(expect.objectContaining({ laterReplyBody: undefined }));
  });

  it("caps AI-judged archives per run and leaves the rest untagged for next time", async () => {
    process.env.TIDY_MAILBOXES_MAX_ARCHIVES_PER_RUN = "2";
    mailboxes({ [GERAL]: ["a", "b", "c"].map((id) => msg({ id, conversationId: id })) });
    classifyMail.mockResolvedValue(verdict({ needsAction: false }));

    await run();

    expect(outlookMock.archiveMessage).toHaveBeenCalledTimes(2);
    expect(outlookMock.setMessageCategories).not.toHaveBeenCalled();
  });
});

describe("mail-triage: supplier invoices", () => {
  const invoice = () =>
    msg({ subject: "Fatura setembro", from: { name: "Limpezas", email: "contas@limpezas.pt" }, hasAttachments: true });

  beforeEach(() => {
    outlookMock.getMessageAttachments.mockResolvedValue([{ name: "fatura_setembro.pdf", contentType: "application/pdf", size: 1 }]);
  });

  it("forwards a supplier invoice to faturas@ once, writing the marker first", async () => {
    mailboxes({ [GERAL]: [invoice()] });
    classifyMail.mockResolvedValue(verdict({ isSupplierInvoice: true, needsAction: false }));

    await run();

    expect(outlookMock.forwardMessage).toHaveBeenCalledWith(GERAL, "m1", [T.invoices], expect.any(String));
    expect(outlookMock.setMessageCategories.mock.invocationCallOrder[0]!).toBeLessThan(
      outlookMock.forwardMessage.mock.invocationCallOrder[0]!,
    );
  });

  it("does not forward if the marker can't be written", async () => {
    mailboxes({ [GERAL]: [invoice()] });
    classifyMail.mockResolvedValue(verdict({ isSupplierInvoice: true }));
    outlookMock.setMessageCategories.mockRejectedValueOnce(new Error("403"));

    await run();

    expect(outlookMock.forwardMessage).not.toHaveBeenCalledWith(GERAL, "m1", [T.invoices], expect.any(String));
  });

  it("a quote never reaches faturas@ (keyword pre-filter), and the AI's 'no' is remembered", async () => {
    outlookMock.getMessageAttachments.mockResolvedValue([{ name: "orcamento.pdf", contentType: "application/pdf", size: 1 }]);
    mailboxes({ [GERAL]: [msg({ subject: "Proposta de orçamento", hasAttachments: true, from: { name: "Lipclean", email: "lipclean.trans@gmail.com" } })] });
    classifyMail.mockResolvedValue(verdict({ tipo: "fornecedor", isSupplierInvoice: true }));

    await run();

    expect(outlookMock.forwardMessage).not.toHaveBeenCalledWith(expect.anything(), expect.anything(), [T.invoices], expect.anything());
  });
});

describe("mail-triage: dry run", () => {
  it("writes nothing anywhere", async () => {
    process.env.MAIL_TRIAGE_DRY_RUN = "true";
    const before = files.get("mail-triage-state.json");
    mailboxes({ [GERAL]: [msg()] });
    classifyMail.mockResolvedValue(verdict({ tipo: "parceiro", needsAction: false }));

    await run();

    expect(notionMock.createPartner).not.toHaveBeenCalled();
    expect(outlookMock.forwardMessage).not.toHaveBeenCalled();
    expect(outlookMock.archiveMessage).not.toHaveBeenCalled();
    expect(outlookMock.setMessageCategories).not.toHaveBeenCalled();
    expect(files.get("mail-triage-state.json")).toBe(before);
  });
});
