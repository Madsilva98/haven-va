import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getChurnRowsByStatus = vi.fn();
const archivePage = vi.fn().mockResolvedValue(undefined);
const getChurnRowByEmail = vi.fn().mockResolvedValue(null);
const createChurnFlag = vi.fn().mockResolvedValue("new-page-id");
const updateChurnFlag = vi.fn().mockResolvedValue(undefined);
vi.mock("../src/notion.js", () => ({
  getChurnRowsByStatus: (...args: unknown[]) => getChurnRowsByStatus(...args),
  archivePage: (...args: unknown[]) => archivePage(...args),
  getChurnRowByEmail: (...args: unknown[]) => getChurnRowByEmail(...args),
  createChurnFlag: (...args: unknown[]) => createChurnFlag(...args),
  updateChurnFlag: (...args: unknown[]) => updateChurnFlag(...args),
}));

const fetchChurnFlags = vi.fn();
vi.mock("../src/lib/churn-signals.js", () => ({
  fetchChurnFlags: (...args: unknown[]) => fetchChurnFlags(...args),
}));

const isStudioSupabaseAvailable = vi.fn().mockReturnValue(true);
vi.mock("../src/lib/studio-supabase.js", () => ({
  isStudioSupabaseAvailable: () => isStudioSupabaseAvailable(),
}));

const sendGroupMessage = vi.fn().mockResolvedValue(1);
vi.mock("../src/lib/telegram.js", () => ({
  sendGroupMessage: (...args: unknown[]) => sendGroupMessage(...args),
}));

import { run } from "../src/crons/churn-risk.js";

// getChurnRowsByStatus is called twice per run — once for the
// Resolvido/Arquivado sweep, once for the open-row reconciliation — so
// tests key the mock's response off which statuses it was called with.
function mockOpenAndClosedRows(
  closed: { id: string; nome: string; email: string; status: string }[],
  open: { id: string; nome: string; email: string; status: string }[],
) {
  getChurnRowsByStatus.mockImplementation((statuses: string[]) =>
    Promise.resolve(statuses.includes("Resolvido") ? closed : open),
  );
}

describe("churn-risk", () => {
  beforeEach(() => {
    process.env.NOTION_CHURN_RISK_DB_ID = "test-churn-db";
    mockOpenAndClosedRows([], []);
  });

  afterEach(() => {
    delete process.env.NOTION_CHURN_RISK_DB_ID;
    getChurnRowsByStatus.mockReset();
    archivePage.mockClear();
    getChurnRowByEmail.mockReset().mockResolvedValue(null);
    createChurnFlag.mockClear();
    updateChurnFlag.mockClear();
    fetchChurnFlags.mockReset().mockResolvedValue({ flags: [], activeEmails: new Set() });
    isStudioSupabaseAvailable.mockReturnValue(true);
    sendGroupMessage.mockClear();
  });

  it("archives Resolvido and Arquivado rows unconditionally — the list must stay 'viva'", async () => {
    mockOpenAndClosedRows(
      [
        { id: "r1", nome: "A", email: "a@x.com", status: "Resolvido" },
        { id: "a1", nome: "B", email: "b@x.com", status: "Arquivado" },
      ],
      [],
    );

    await run();

    expect(getChurnRowsByStatus).toHaveBeenCalledWith(["Resolvido", "Arquivado"]);
    expect(archivePage).toHaveBeenCalledWith("r1");
    expect(archivePage).toHaveBeenCalledWith("a1");
  });

  it("still creates new flags and posts a digest even when nothing needs archiving", async () => {
    fetchChurnFlags.mockResolvedValue({
      flags: [
        {
          email: "new@x.com",
          name: "New Risk",
          plano: "4x Monthly",
          telefone: null,
          signals: [{ type: "Sem reservas 14+ dias", detail: "25 dias sem reservar" }],
        },
      ],
      activeEmails: new Set(["new@x.com"]),
    });

    await run();

    expect(createChurnFlag).toHaveBeenCalledWith(
      "New Risk",
      "new@x.com",
      ["Sem reservas 14+ dias"],
      "25 dias sem reservar",
      "4x Monthly",
      null,
    );
    expect(sendGroupMessage).toHaveBeenCalledTimes(1);
  });

  it("does nothing when Studio Supabase isn't configured, without touching closed rows", async () => {
    isStudioSupabaseAvailable.mockReturnValue(false);

    await run();

    expect(getChurnRowsByStatus).not.toHaveBeenCalled();
    expect(fetchChurnFlags).not.toHaveBeenCalled();
  });

  it("syncs signals to exactly this week's set instead of unioning — a resolved signal actually drops off", async () => {
    fetchChurnFlags.mockResolvedValue({
      flags: [
        {
          email: "c@x.com",
          name: "Carla",
          plano: "4x Monthly",
          telefone: null,
          signals: [{ type: "Pagamento falhado", detail: "pagamento falhado a 10/09" }],
        },
      ],
      activeEmails: new Set(["c@x.com"]),
    });
    getChurnRowByEmail.mockResolvedValue({
      id: "row-c",
      sinais: ["Sem reservas 14+ dias", "Pagamento falhado"],
    });

    await run();

    // Booked again since being flagged — "Sem reservas 14+ dias" is gone,
    // "Pagamento falhado" is the only signal left, not a union of both.
    expect(updateChurnFlag).toHaveBeenCalledWith("row-c", ["Pagamento falhado"], "pagamento falhado a 10/09");
    expect(sendGroupMessage).toHaveBeenCalledTimes(1);
  });

  it("updates a still-active row to no signals when Studio Supabase no longer flags it at all, without archiving", async () => {
    mockOpenAndClosedRows([], [{ id: "row-d", nome: "Diana", email: "d@x.com", status: "Aberto" }]);
    fetchChurnFlags.mockResolvedValue({ flags: [], activeEmails: new Set(["d@x.com"]) });

    await run();

    expect(updateChurnFlag).toHaveBeenCalledWith("row-d", [], "Sem sinais de risco na última verificação.");
    expect(archivePage).not.toHaveBeenCalled();
    expect(sendGroupMessage).toHaveBeenCalledTimes(1);
  });

  it("auto-archives an open row once the person is no longer an active subscriber at all", async () => {
    mockOpenAndClosedRows([], [{ id: "row-e", nome: "Andrew", email: "e@x.com", status: "Aberto" }]);
    fetchChurnFlags.mockResolvedValue({ flags: [], activeEmails: new Set() });

    await run();

    expect(archivePage).toHaveBeenCalledWith("row-e");
    expect(updateChurnFlag).not.toHaveBeenCalled();
  });
});
