import { afterEach, describe, expect, it, vi } from "vitest";

const getActiveFounderFocuses = vi.fn();
const getOrCreateFounderFocusRow = vi.fn().mockResolvedValue("page-id");
const rolloverFounderFocusWeek = vi.fn().mockResolvedValue("page-id-2");
vi.mock("../src/notion.js", () => ({
  getActiveFounderFocuses: (...args: unknown[]) => getActiveFounderFocuses(...args),
  getOrCreateFounderFocusRow: (...args: unknown[]) => getOrCreateFounderFocusRow(...args),
  rolloverFounderFocusWeek: (...args: unknown[]) => rolloverFounderFocusWeek(...args),
}));

const sendDM = vi.fn().mockResolvedValue(1);
vi.mock("../src/lib/telegram.js", () => ({
  sendDM: (...args: unknown[]) => sendDM(...args),
}));

const getTelegramId = vi.fn().mockReturnValue(12345);
vi.mock("../src/lib/founders.js", () => ({
  getTelegramId: (...args: unknown[]) => getTelegramId(...args),
}));

const markFounderAwaitingGoals = vi.fn();
vi.mock("../src/bot/focusCallbacks.js", () => ({
  markFounderAwaitingGoals: (...args: unknown[]) => markFounderAwaitingGoals(...args),
}));

import { runFocusCumpridoAsk, runFocusRollover } from "../src/crons/founder-focus-cycle.js";

// 2026-09-13 is a Sunday (end of an ISO week), 2026-09-14 is the following
// Monday (start of the next ISO week) — see test/remind.test.ts.
const SUNDAY_END_OF_WEEK = new Date("2026-09-13T17:00:00.000Z"); // 18:00 Lisbon
const MONDAY_NEW_WEEK = new Date("2026-09-14T07:00:00.000Z"); // 08:00 Lisbon

describe("founder-focus-cycle", () => {
  afterEach(() => {
    getActiveFounderFocuses.mockReset();
    getOrCreateFounderFocusRow.mockClear();
    rolloverFounderFocusWeek.mockClear();
    sendDM.mockClear();
    getTelegramId.mockReturnValue(12345);
    markFounderAwaitingGoals.mockClear();
  });

  describe("runFocusCumpridoAsk", () => {
    it("asks when the active row's week matches today's ISO week", async () => {
      getActiveFounderFocuses.mockResolvedValueOnce([
        { founder: "Madalena", weekNumber: 37, focoOperacional: "Fechar parcerias" },
      ]);
      await runFocusCumpridoAsk(SUNDAY_END_OF_WEEK);
      expect(sendDM).toHaveBeenCalledTimes(1);
    });

    it("still asks when the active row is from the PREVIOUS ISO week — the bug this fixed", async () => {
      // The active row was never rolled over yet (still tagged with the
      // week that just ended, 37 — same as SUNDAY_END_OF_WEEK above), but
      // "now" is already the first day of a new ISO week, 38 (the
      // meeting-triggered fallback landed on a Monday). The old
      // `entry.weekNumber !== currentWeek` filter would silently skip this
      // founder entirely — getActiveFounderFocuses() already guarantees
      // this row is the one that needs asking about, regardless of week
      // parity with "today".
      getActiveFounderFocuses.mockResolvedValueOnce([
        { founder: "Mafalda", weekNumber: 37, focoOperacional: "Conteúdo" },
      ]);
      await runFocusCumpridoAsk(MONDAY_NEW_WEEK);
      expect(sendDM).toHaveBeenCalledTimes(1);
      // Fetches/creates the row for the entry's OWN week, not "today's".
      expect(getOrCreateFounderFocusRow).toHaveBeenCalledWith("Mafalda", 37, { activate: false });
    });

    it("skips a founder with no Telegram id on file", async () => {
      getActiveFounderFocuses.mockResolvedValueOnce([
        { founder: "Beatriz", weekNumber: 37, focoOperacional: "Ops" },
      ]);
      getTelegramId.mockReturnValueOnce(null);
      await runFocusCumpridoAsk(SUNDAY_END_OF_WEEK);
      expect(sendDM).not.toHaveBeenCalled();
    });
  });

  describe("runFocusRollover", () => {
    it("rolls over and asks for new goals when the active row is still last week's", async () => {
      getActiveFounderFocuses.mockResolvedValueOnce([
        { founder: "Madalena", weekNumber: 37, focoOperacional: "Fechar parcerias" },
      ]);
      await runFocusRollover(MONDAY_NEW_WEEK);
      expect(rolloverFounderFocusWeek).toHaveBeenCalledWith("Madalena", 38);
      expect(markFounderAwaitingGoals).toHaveBeenCalledWith(12345, 38);
      expect(sendDM).toHaveBeenCalledWith(12345, "quais são os teus objetivos desta semana?");
    });

    it("skips a founder already on the current week's row (already tapped Sim/Não)", async () => {
      getActiveFounderFocuses.mockResolvedValueOnce([
        { founder: "Mafalda", weekNumber: 38, focoOperacional: "Conteúdo" },
      ]);
      await runFocusRollover(MONDAY_NEW_WEEK);
      expect(rolloverFounderFocusWeek).not.toHaveBeenCalled();
      expect(sendDM).not.toHaveBeenCalled();
    });
  });
});
