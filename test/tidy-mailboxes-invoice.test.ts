import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { OutlookMessage } from "../src/lib/outlook.js";

const outlookMock = vi.hoisted(() => ({
  isAuthenticated: vi.fn().mockReturnValue(true),
  listInboxMessages: vi.fn(),
  listSentMessages: vi.fn(),
  getMessageAttachments: vi.fn(),
  setMessageCategories: vi.fn().mockResolvedValue(undefined),
  forwardMessage: vi.fn().mockResolvedValue(undefined),
  archiveMessage: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../src/lib/outlook.js", async (importOriginal) => {
  // Real keep-tag helpers (pure functions), mocked Graph calls.
  const actual = await importOriginal<typeof import("../src/lib/outlook.js")>();
  return {
    ...outlookMock,
    isKeptInInbox: actual.isKeptInInbox,
    keptConversationIds: actual.keptConversationIds,
  };
});

const classifyInvoice = vi.fn();
vi.mock("../src/bot/classify-invoice.js", () => ({
  classifyInvoice: (...args: unknown[]) => classifyInvoice(...args),
}));

const classifyMailboxThread = vi.fn();
vi.mock("../src/bot/classify-mailbox-thread.js", () => ({
  classifyMailboxThread: (...args: unknown[]) => classifyMailboxThread(...args),
}));

import { run } from "../src/crons/tidy-mailboxes.js";

const MAILBOX = "geral@thehavenpilates.pt";
const FATURAS = "faturas@thehavenpilates.pt";

function msg(overrides: Partial<OutlookMessage> = {}): OutlookMessage {
  return {
    id: "m1",
    mailbox: MAILBOX,
    subject: "Fatura setembro",
    from: { name: "Limpezas Lda", email: "contas@limpezas.pt" },
    to: [],
    receivedDateTime: "2026-09-20T10:00:00Z",
    bodyPreview: "",
    body: "Segue a fatura em anexo.",
    webLink: "",
    hasAttachments: true,
    categories: [],
    isRead: true,
    lastModifiedDateTime: "2026-09-20T10:00:00Z",
    conversationId: "c1",
    sentDateTime: "2026-09-20T10:00:00Z",
    parentFolderId: "inbox",
    ...overrides,
  };
}

describe("tidy-mailboxes invoice forwarding", () => {
  beforeEach(() => {
    process.env.OUTLOOK_TIDY_MAILBOXES = MAILBOX;
    process.env.OUTLOOK_INVOICES_FORWARD_TO = FATURAS;
    outlookMock.listSentMessages.mockResolvedValue([]);
    outlookMock.getMessageAttachments.mockResolvedValue([
      { name: "fatura_setembro.pdf", contentType: "application/pdf", size: 1000 },
    ]);
    classifyMailboxThread.mockResolvedValue({ needsAction: true, reason: "pendente" });
  });

  afterEach(() => {
    vi.clearAllMocks();
    outlookMock.isAuthenticated.mockReturnValue(true);
    outlookMock.setMessageCategories.mockResolvedValue(undefined);
  });

  it("forwards a supplier invoice once, writing the marker before forwarding", async () => {
    outlookMock.listInboxMessages.mockResolvedValue([msg()]);
    classifyInvoice.mockResolvedValue({ isSupplierInvoice: true, reason: "fatura", decided: true });

    await run();

    expect(outlookMock.forwardMessage).toHaveBeenCalledTimes(1);
    const markerOrder = outlookMock.setMessageCategories.mock.invocationCallOrder[0]!;
    const forwardOrder = outlookMock.forwardMessage.mock.invocationCallOrder[0]!;
    expect(markerOrder).toBeLessThan(forwardOrder);
    // The later "revisto" tag must keep the invoice marker (PATCH replaces the list)
    expect(outlookMock.setMessageCategories).toHaveBeenLastCalledWith(MAILBOX, "m1", [
      "TidyBot: fatura enviada",
      "TidyBot: revisto",
    ]);
  });

  it("never re-forwards a message already marked, even once its revisto tag is stale", async () => {
    outlookMock.listInboxMessages.mockResolvedValue([
      msg({
        categories: ["TidyBot: fatura enviada", "TidyBot: revisto"],
        lastModifiedDateTime: "2026-01-01T00:00:00Z",
      }),
    ]);

    await run();

    expect(classifyInvoice).not.toHaveBeenCalled();
    expect(outlookMock.forwardMessage).not.toHaveBeenCalled();
  });

  it("does not forward if the marker can't be written", async () => {
    outlookMock.listInboxMessages.mockResolvedValue([msg()]);
    classifyInvoice.mockResolvedValue({ isSupplierInvoice: true, reason: "fatura", decided: true });
    outlookMock.setMessageCategories.mockRejectedValueOnce(new Error("403"));

    await run();

    expect(outlookMock.forwardMessage).not.toHaveBeenCalled();
  });

  it("does not forward an invoice the studio issued to a client, and remembers that", async () => {
    outlookMock.listInboxMessages.mockResolvedValue([
      msg({ subject: "Recibo da sua compra", from: { name: "Stripe", email: "receipts@stripe.com" } }),
    ]);
    classifyInvoice.mockResolvedValue({ isSupplierInvoice: false, reason: "recibo a cliente", decided: true });

    await run();

    expect(outlookMock.forwardMessage).not.toHaveBeenCalled();
    expect(outlookMock.setMessageCategories).toHaveBeenCalledWith(MAILBOX, "m1", ["TidyBot: não é fatura"]);
  });

  it("does not ask the LLM or forward a quote (lipclean case)", async () => {
    outlookMock.listInboxMessages.mockResolvedValue([
      msg({
        subject: "Proposta de orçamento",
        from: { name: "Lipclean", email: "lipclean.trans@gmail.com" },
        body: "Segue proposta. Faturação mensal, envio a fatura no fim do mês.",
      }),
    ]);
    outlookMock.getMessageAttachments.mockResolvedValue([
      { name: "Proposta Haven.pdf", contentType: "application/pdf", size: 1000 },
    ]);

    await run();

    expect(classifyInvoice).not.toHaveBeenCalled();
    expect(outlookMock.forwardMessage).not.toHaveBeenCalled();
  });

  it("never touches a message the founder tagged 'não arquivar' (Fit4Life case)", async () => {
    outlookMock.listInboxMessages.mockResolvedValue([
      msg({ categories: ["TidyBot: não arquivar"], subject: "Re: Stages Cycling - Fit4Life" }),
    ]);
    classifyMailboxThread.mockResolvedValue({ needsAction: false, reason: "resolvido" });

    await run();

    expect(classifyMailboxThread).not.toHaveBeenCalled();
    expect(classifyInvoice).not.toHaveBeenCalled();
    expect(outlookMock.archiveMessage).not.toHaveBeenCalled();
    expect(outlookMock.forwardMessage).not.toHaveBeenCalled();
    expect(outlookMock.setMessageCategories).not.toHaveBeenCalled();
  });

  it("'não arquivar' wins over 'devia ter arquivado' when both are on a message", async () => {
    outlookMock.listInboxMessages.mockResolvedValue([
      msg({ categories: ["TidyBot: devia ter arquivado", "TidyBot: não arquivar"] }),
    ]);

    await run();

    expect(outlookMock.archiveMessage).not.toHaveBeenCalled();
  });

  it("'não arquivar' protects the whole thread, including a later untagged reply", async () => {
    outlookMock.listInboxMessages.mockResolvedValue([
      msg({ id: "reply", conversationId: "fit4life", hasAttachments: false, receivedDateTime: "2026-09-25T10:00:00Z" }),
      msg({ id: "original", conversationId: "fit4life", hasAttachments: false, categories: ["TidyBot: não arquivar"] }),
      msg({ id: "other", conversationId: "newsletter", hasAttachments: false }),
    ]);
    classifyMailboxThread.mockResolvedValue({ needsAction: false, reason: "resolvido" });

    await run();

    expect(outlookMock.archiveMessage).toHaveBeenCalledTimes(1);
    expect(outlookMock.archiveMessage).toHaveBeenCalledWith(MAILBOX, "other");
  });

  it("does not treat our own auto-forward as the Haven having replied", async () => {
    outlookMock.listInboxMessages.mockResolvedValue([msg({ hasAttachments: false })]);
    outlookMock.listSentMessages.mockResolvedValue([
      msg({
        id: "s1",
        to: [{ name: "", email: FATURAS }],
        body: "Reencaminhado automaticamente (parece conter uma fatura).",
        sentDateTime: "2026-09-21T10:00:00Z",
      }),
    ]);

    await run();

    expect(classifyMailboxThread).toHaveBeenCalledWith(
      expect.objectContaining({ body: "Segue a fatura em anexo." }),
    );
  });
});
