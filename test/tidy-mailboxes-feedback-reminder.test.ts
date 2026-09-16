import { afterEach, describe, expect, it, vi } from "vitest";

const readFileSync = vi.fn();
vi.mock("node:fs", () => ({
  readFileSync: (...args: unknown[]) => readFileSync(...args),
}));

const getTelegramId = vi.fn().mockReturnValue(12345);
vi.mock("../src/lib/founders.js", () => ({
  getTelegramId: (...args: unknown[]) => getTelegramId(...args),
}));

const sendDM = vi.fn().mockResolvedValue(1);
vi.mock("../src/lib/telegram.js", () => ({
  sendDM: (...args: unknown[]) => sendDM(...args),
}));

import { run } from "../src/crons/tidy-mailboxes-feedback-reminder.js";

function logWithEntries(...statuses: string[]): string {
  return statuses
    .map((s, i) => `## Entry ${i}\n\nStatus: **${s}**\n`)
    .join("\n---\n\n");
}

describe("tidy-mailboxes-feedback-reminder", () => {
  afterEach(() => {
    readFileSync.mockReset();
    getTelegramId.mockReturnValue(12345);
    sendDM.mockClear();
  });

  it("sends nothing when there are no pending-review entries", async () => {
    readFileSync.mockReturnValue(logWithEntries("approved", "applied", "rejected"));
    await run();
    expect(sendDM).not.toHaveBeenCalled();
  });

  it("sends a singular message when exactly one entry is pending review", async () => {
    readFileSync.mockReturnValue(logWithEntries("pending review", "approved"));
    await run();
    expect(sendDM).toHaveBeenCalledTimes(1);
    expect(sendDM).toHaveBeenCalledWith(12345, expect.stringContaining("1 apontamento pending review"));
  });

  it("sends a plural message with the correct count for multiple pending entries", async () => {
    readFileSync.mockReturnValue(logWithEntries("pending review", "pending review", "pending review"));
    await run();
    expect(sendDM).toHaveBeenCalledTimes(1);
    expect(sendDM).toHaveBeenCalledWith(12345, expect.stringContaining("3 apontamentos pending review"));
  });

  it("does nothing and doesn't throw when the log file can't be read", async () => {
    readFileSync.mockImplementation(() => {
      throw new Error("ENOENT");
    });
    await expect(run()).resolves.toBeUndefined();
    expect(sendDM).not.toHaveBeenCalled();
  });

  it("skips sending when there's no Telegram id on file for Madalena", async () => {
    readFileSync.mockReturnValue(logWithEntries("pending review"));
    getTelegramId.mockReturnValueOnce(null);
    await run();
    expect(sendDM).not.toHaveBeenCalled();
  });
});
