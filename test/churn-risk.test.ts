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

const fetchChurnFlags = vi.fn().mockResolvedValue([]);
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

describe("churn-risk", () => {
  beforeEach(() => {
    process.env.NOTION_CHURN_RISK_DB_ID = "test-churn-db";
    getChurnRowsByStatus.mockResolvedValue([]);
  });

  afterEach(() => {
    delete process.env.NOTION_CHURN_RISK_DB_ID;
    getChurnRowsByStatus.mockReset();
    archivePage.mockClear();
    getChurnRowByEmail.mockReset().mockResolvedValue(null);
    createChurnFlag.mockClear();
    updateChurnFlag.mockClear();
    fetchChurnFlags.mockReset().mockResolvedValue([]);
    isStudioSupabaseAvailable.mockReturnValue(true);
    sendGroupMessage.mockClear();
  });

  it("archives Resolvido and Arquivado rows unconditionally — the list must stay 'viva'", async () => {
    getChurnRowsByStatus.mockResolvedValue([
      { id: "r1", email: "a@x.com", status: "Resolvido" },
      { id: "a1", email: "b@x.com", status: "Arquivado" },
    ]);

    await run();

    expect(getChurnRowsByStatus).toHaveBeenCalledWith(["Resolvido", "Arquivado"]);
    expect(archivePage).toHaveBeenCalledWith("r1");
    expect(archivePage).toHaveBeenCalledWith("a1");
  });

  it("still creates new flags and posts a digest even when nothing needs archiving", async () => {
    fetchChurnFlags.mockResolvedValue([
      {
        email: "new@x.com",
        name: "New Risk",
        plano: "4x Monthly",
        telefone: null,
        signals: [{ type: "Sem reservas 21+ dias", detail: "25 dias sem reservar" }],
      },
    ]);

    await run();

    expect(createChurnFlag).toHaveBeenCalledWith(
      "New Risk",
      "new@x.com",
      ["Sem reservas 21+ dias"],
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
});
