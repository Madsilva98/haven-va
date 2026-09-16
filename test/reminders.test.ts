import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReminderRow } from "../src/types.js";

const getDueReminders = vi.fn();
const markReminderSent = vi.fn().mockResolvedValue(undefined);
const createReminder = vi.fn().mockResolvedValue("new-id");
vi.mock("../src/notion.js", () => ({
  getDueReminders: (...args: unknown[]) => getDueReminders(...args),
  markReminderSent: (...args: unknown[]) => markReminderSent(...args),
  createReminder: (...args: unknown[]) => createReminder(...args),
}));

const getTelegramId = vi.fn().mockReturnValue(12345);
vi.mock("../src/lib/founders.js", () => ({
  getTelegramId: (...args: unknown[]) => getTelegramId(...args),
}));

const sendDM = vi.fn().mockResolvedValue(1);
vi.mock("../src/lib/telegram.js", () => ({
  sendDM: (...args: unknown[]) => sendDM(...args),
}));

import { run } from "../src/crons/reminders.js";

function reminder(overrides: Partial<ReminderRow> = {}): ReminderRow {
  return {
    id: "r1",
    texto: "ligar ao fornecedor",
    paraQuem: ["Madalena"],
    quando: "2026-09-16T08:00:00.000Z",
    origem: "manual",
    enviado: false,
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("reminders cron", () => {
  afterEach(() => {
    getDueReminders.mockReset();
    markReminderSent.mockReset().mockResolvedValue(undefined);
    createReminder.mockReset().mockResolvedValue("new-id");
    getTelegramId.mockReturnValue(12345);
    sendDM.mockReset().mockResolvedValue(1);
  });

  it("sends due reminders and marks them sent", async () => {
    getDueReminders.mockResolvedValueOnce([reminder()]);
    await run();
    expect(markReminderSent).toHaveBeenCalledWith("r1");
    expect(sendDM).toHaveBeenCalledTimes(1);
  });

  it("skips a second run that starts while the first is still in flight", async () => {
    const { promise, resolve } = deferred<ReminderRow[]>();
    getDueReminders.mockReturnValueOnce(promise);

    const firstRun = run();
    // The first run is now awaiting getDueReminders — still "in flight".
    const secondRun = run();
    await secondRun;

    // The overlapping second call returned immediately without touching
    // Notion or Telegram at all.
    expect(sendDM).not.toHaveBeenCalled();
    expect(markReminderSent).not.toHaveBeenCalled();

    resolve([reminder()]);
    await firstRun;

    // Only the first run's reminder went out — exactly once.
    expect(sendDM).toHaveBeenCalledTimes(1);
    expect(markReminderSent).toHaveBeenCalledTimes(1);
  });

  it("allows a normal run again once the previous one has finished", async () => {
    getDueReminders.mockResolvedValueOnce([reminder()]);
    await run();
    expect(sendDM).toHaveBeenCalledTimes(1);

    getDueReminders.mockResolvedValueOnce([reminder({ id: "r2" })]);
    await run();
    expect(sendDM).toHaveBeenCalledTimes(2);
    expect(markReminderSent).toHaveBeenCalledWith("r2");
  });
});
