import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const listEventsInRange = vi.fn();
vi.mock("../src/lib/calendar.js", () => ({
  listEventsInRange: (...args: unknown[]) => listEventsInRange(...args),
}));

const sendWeeklyPriorities = vi.fn().mockResolvedValue(undefined);
vi.mock("../src/crons/weekly-priorities.js", () => ({
  run: (...args: unknown[]) => sendWeeklyPriorities(...args),
}));

const runFocusRollover = vi.fn().mockResolvedValue(undefined);
vi.mock("../src/crons/founder-focus-cycle.js", () => ({
  runFocusRollover: (...args: unknown[]) => runFocusRollover(...args),
}));

import { run } from "../src/crons/founder-meeting-check.js";

interface FakeEvent {
  id: string;
  title: string;
  start: Date;
  end: Date;
  calendarId: string;
  calendarName: string;
  allDay: boolean;
}

function meetingEvent(endIso: string, title = "Recurring Founders Meeting"): FakeEvent {
  const end = new Date(endIso);
  return { id: "e1", title, start: end, end, calendarId: "primary", calendarName: "primary", allDay: false };
}

// 2026-09-14 is a Monday (confirmed against test/remind.test.ts's DST cases).
const MONDAY = new Date("2026-09-14T07:00:00.000Z"); // 08:00 Lisbon
const WEDNESDAY = new Date("2026-09-16T07:00:00.000Z"); // 08:00 Lisbon

describe("founder-meeting-check", () => {
  const originalTz = process.env.TZ;

  beforeAll(() => {
    process.env.TZ = "Europe/Lisbon";
  });

  afterAll(() => {
    process.env.TZ = originalTz;
  });

  afterEach(() => {
    listEventsInRange.mockReset();
    sendWeeklyPriorities.mockClear();
    runFocusRollover.mockClear();
  });

  it("sends when the meeting ended since yesterday, even on a non-Monday", async () => {
    listEventsInRange.mockResolvedValueOnce([meetingEvent("2026-09-15T13:30:00.000Z")]);
    await run(WEDNESDAY);
    expect(sendWeeklyPriorities).toHaveBeenCalledTimes(1);
    // Early return: never bothers checking "scheduled this week".
    expect(listEventsInRange).toHaveBeenCalledTimes(1);
    // Focus rollover fires together with the team message, same `now`.
    expect(runFocusRollover).toHaveBeenCalledTimes(1);
    expect(runFocusRollover).toHaveBeenCalledWith(WEDNESDAY);
  });

  it("does nothing on a non-Monday when no meeting happened", async () => {
    listEventsInRange.mockResolvedValueOnce([]);
    await run(WEDNESDAY);
    expect(sendWeeklyPriorities).not.toHaveBeenCalled();
    expect(runFocusRollover).not.toHaveBeenCalled();
  });

  it("sends the Monday fallback when no meeting happened and none is scheduled this week", async () => {
    listEventsInRange
      .mockResolvedValueOnce([]) // nothing happened since yesterday
      .mockResolvedValueOnce([]); // nothing scheduled this week
    await run(MONDAY);
    expect(sendWeeklyPriorities).toHaveBeenCalledTimes(1);
    expect(runFocusRollover).toHaveBeenCalledTimes(1);
    expect(runFocusRollover).toHaveBeenCalledWith(MONDAY);
  });

  it("skips the Monday fallback when the meeting is scheduled later this week", async () => {
    listEventsInRange
      .mockResolvedValueOnce([]) // nothing happened since yesterday
      .mockResolvedValueOnce([meetingEvent("2026-09-15T13:30:00.000Z")]); // Tuesday meeting on the calendar
    await run(MONDAY);
    expect(sendWeeklyPriorities).not.toHaveBeenCalled();
    expect(runFocusRollover).not.toHaveBeenCalled();
  });

  it("ignores events that don't match the meeting title", async () => {
    listEventsInRange.mockResolvedValueOnce([meetingEvent("2026-09-15T13:30:00.000Z", "Dentist appointment")]);
    await run(WEDNESDAY);
    expect(sendWeeklyPriorities).not.toHaveBeenCalled();
    expect(runFocusRollover).not.toHaveBeenCalled();
  });

  it("matches the short 'Founders Meeting' title too, case-insensitively", async () => {
    listEventsInRange.mockResolvedValueOnce([meetingEvent("2026-09-15T13:30:00.000Z", "founders MEETING")]);
    await run(WEDNESDAY);
    expect(sendWeeklyPriorities).toHaveBeenCalledTimes(1);
    expect(runFocusRollover).toHaveBeenCalledTimes(1);
  });

  it("sends anyway on Monday if the 'scheduled this week' lookup fails (fail-safe)", async () => {
    listEventsInRange
      .mockResolvedValueOnce([]) // nothing happened since yesterday
      .mockRejectedValueOnce(new Error("calendar API down")); // scheduled-this-week lookup fails
    await run(MONDAY);
    expect(sendWeeklyPriorities).toHaveBeenCalledTimes(1);
    expect(runFocusRollover).toHaveBeenCalledTimes(1);
  });
});
