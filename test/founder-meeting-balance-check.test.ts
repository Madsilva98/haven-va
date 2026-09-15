import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const listEventsInRange = vi.fn();
vi.mock("../src/lib/calendar.js", () => ({
  listEventsInRange: (...args: unknown[]) => listEventsInRange(...args),
}));

const sendWeekBalance = vi.fn().mockResolvedValue(undefined);
vi.mock("../src/crons/week-balance.js", () => ({
  run: (...args: unknown[]) => sendWeekBalance(...args),
}));

const runFocusCumpridoAsk = vi.fn().mockResolvedValue(undefined);
vi.mock("../src/crons/founder-focus-cycle.js", () => ({
  runFocusCumpridoAsk: (...args: unknown[]) => runFocusCumpridoAsk(...args),
}));

import { run } from "../src/crons/founder-meeting-balance-check.js";

interface FakeEvent {
  id: string;
  title: string;
  start: Date;
  end: Date;
  calendarId: string;
  calendarName: string;
  allDay: boolean;
}

function meetingEvent(iso: string, title = "Recurring Founders Meeting"): FakeEvent {
  const d = new Date(iso);
  return { id: "e1", title, start: d, end: d, calendarId: "primary", calendarName: "primary", allDay: false };
}

// 2026-09-14 is a Monday (see test/remind.test.ts / test/founder-meeting-check.test.ts).
const MONDAY = new Date("2026-09-14T07:00:00.000Z"); // 08:00 Lisbon
const TUESDAY = new Date("2026-09-15T07:00:00.000Z"); // 08:00 Lisbon
const SUNDAY = new Date("2026-09-20T07:00:00.000Z"); // 08:00 Lisbon

describe("founder-meeting-balance-check", () => {
  const originalTz = process.env.TZ;

  beforeAll(() => {
    process.env.TZ = "Europe/Lisbon";
  });

  afterAll(() => {
    process.env.TZ = originalTz;
  });

  afterEach(() => {
    listEventsInRange.mockReset();
    sendWeekBalance.mockClear();
    runFocusCumpridoAsk.mockClear();
  });

  it("sends when the meeting is scheduled for today, even on a non-Sunday", async () => {
    listEventsInRange.mockResolvedValueOnce([meetingEvent("2026-09-15T13:30:00.000Z")]);
    await run(TUESDAY);
    expect(sendWeekBalance).toHaveBeenCalledTimes(1);
    // Early return: never bothers checking "scheduled this week".
    expect(listEventsInRange).toHaveBeenCalledTimes(1);
    // Focus ask fires together with the team message, same `now`.
    expect(runFocusCumpridoAsk).toHaveBeenCalledTimes(1);
    expect(runFocusCumpridoAsk).toHaveBeenCalledWith(TUESDAY);
  });

  it("does nothing on a non-Sunday when the meeting isn't today", async () => {
    listEventsInRange.mockResolvedValueOnce([]);
    await run(MONDAY);
    expect(sendWeekBalance).not.toHaveBeenCalled();
    expect(runFocusCumpridoAsk).not.toHaveBeenCalled();
  });

  it("sends the Sunday fallback when no meeting happened today and none was scheduled this week", async () => {
    listEventsInRange
      .mockResolvedValueOnce([]) // not scheduled today
      .mockResolvedValueOnce([]); // nothing scheduled all week
    await run(SUNDAY);
    expect(sendWeekBalance).toHaveBeenCalledTimes(1);
    expect(runFocusCumpridoAsk).toHaveBeenCalledTimes(1);
    expect(runFocusCumpridoAsk).toHaveBeenCalledWith(SUNDAY);
  });

  it("skips the Sunday fallback when the meeting already happened earlier this week", async () => {
    listEventsInRange
      .mockResolvedValueOnce([]) // not scheduled today (Sunday)
      .mockResolvedValueOnce([meetingEvent("2026-09-15T13:30:00.000Z")]); // Tuesday meeting on the calendar
    await run(SUNDAY);
    expect(sendWeekBalance).not.toHaveBeenCalled();
    expect(runFocusCumpridoAsk).not.toHaveBeenCalled();
  });

  it("ignores events that don't match the meeting title", async () => {
    listEventsInRange.mockResolvedValueOnce([meetingEvent("2026-09-15T13:30:00.000Z", "Dentist appointment")]);
    await run(TUESDAY);
    expect(sendWeekBalance).not.toHaveBeenCalled();
    expect(runFocusCumpridoAsk).not.toHaveBeenCalled();
  });

  it("sends anyway on Sunday if the 'scheduled this week' lookup fails (fail-safe)", async () => {
    listEventsInRange
      .mockResolvedValueOnce([]) // not scheduled today
      .mockRejectedValueOnce(new Error("calendar API down"));
    await run(SUNDAY);
    expect(sendWeekBalance).toHaveBeenCalledTimes(1);
    expect(runFocusCumpridoAsk).toHaveBeenCalledTimes(1);
  });
});
