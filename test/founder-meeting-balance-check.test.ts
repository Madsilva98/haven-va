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
const WEDNESDAY = new Date("2026-09-16T07:00:00.000Z"); // 08:00 Lisbon
const SUNDAY_BEFORE_MONDAY = new Date("2026-09-13T07:00:00.000Z"); // yesterday relative to MONDAY

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

  it("sends when the meeting is scheduled for today, even on a non-Monday", async () => {
    listEventsInRange.mockResolvedValueOnce([meetingEvent("2026-09-15T13:30:00.000Z")]);
    await run(TUESDAY);
    expect(sendWeekBalance).toHaveBeenCalledTimes(1);
    expect(sendWeekBalance).toHaveBeenCalledWith(TUESDAY);
    // Early return: never bothers checking "scheduled last week".
    expect(listEventsInRange).toHaveBeenCalledTimes(1);
    // Focus ask fires together with the team message, same `now`.
    expect(runFocusCumpridoAsk).toHaveBeenCalledTimes(1);
    expect(runFocusCumpridoAsk).toHaveBeenCalledWith(TUESDAY);
  });

  it("does nothing on a non-Monday when the meeting isn't today", async () => {
    listEventsInRange.mockResolvedValueOnce([]);
    await run(WEDNESDAY);
    expect(sendWeekBalance).not.toHaveBeenCalled();
    expect(runFocusCumpridoAsk).not.toHaveBeenCalled();
  });

  it("sends the Monday fallback, recapping the week that just ended, when no meeting happened today and none was scheduled last week", async () => {
    listEventsInRange
      .mockResolvedValueOnce([]) // not scheduled today
      .mockResolvedValueOnce([]); // nothing scheduled last week
    await run(MONDAY);
    expect(sendWeekBalance).toHaveBeenCalledTimes(1);
    expect(sendWeekBalance).toHaveBeenCalledWith(SUNDAY_BEFORE_MONDAY);
    expect(runFocusCumpridoAsk).toHaveBeenCalledTimes(1);
    expect(runFocusCumpridoAsk).toHaveBeenCalledWith(MONDAY);
  });

  it("skips the Monday fallback when the meeting was scheduled last week", async () => {
    listEventsInRange
      .mockResolvedValueOnce([]) // not scheduled today (Monday)
      .mockResolvedValueOnce([meetingEvent("2026-09-08T13:30:00.000Z")]); // Tuesday of last week
    await run(MONDAY);
    expect(sendWeekBalance).not.toHaveBeenCalled();
    expect(runFocusCumpridoAsk).not.toHaveBeenCalled();
  });

  it("ignores events that don't match the meeting title", async () => {
    listEventsInRange.mockResolvedValueOnce([meetingEvent("2026-09-15T13:30:00.000Z", "Dentist appointment")]);
    await run(TUESDAY);
    expect(sendWeekBalance).not.toHaveBeenCalled();
    expect(runFocusCumpridoAsk).not.toHaveBeenCalled();
  });

  it("sends anyway on Monday if the 'scheduled last week' lookup fails (fail-safe)", async () => {
    listEventsInRange
      .mockResolvedValueOnce([]) // not scheduled today
      .mockRejectedValueOnce(new Error("calendar API down"));
    await run(MONDAY);
    expect(sendWeekBalance).toHaveBeenCalledTimes(1);
    expect(sendWeekBalance).toHaveBeenCalledWith(SUNDAY_BEFORE_MONDAY);
    expect(runFocusCumpridoAsk).toHaveBeenCalledTimes(1);
  });
});
