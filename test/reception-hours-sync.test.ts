import { beforeEach, describe, expect, it, vi } from "vitest";

const listCalendarEventsStrict = vi.fn();
vi.mock("../src/lib/calendar.js", () => ({
  listCalendarEventsStrict: (...args: unknown[]) => listCalendarEventsStrict(...args),
}));

const clientQuery = vi.fn();
const withTransaction = vi.fn(async (fn: (c: { query: typeof clientQuery }) => Promise<unknown>) => fn({ query: clientQuery }));
vi.mock("../src/lib/studio-db.js", () => ({
  isStudioDbAvailable: () => true,
  withTransaction: (fn: never) => withTransaction(fn),
}));

import { rowsToSync, run, syncUntil } from "../src/crons/reception-hours-sync.js";

const NOW = new Date("2026-10-01T23:30:00+01:00");

function ev(id: string, title: string, start: string, end: string, allDay = false) {
  return { id, title, start: new Date(start), end: new Date(end), calendarId: "rececao", calendarName: "Receção", allDay };
}

const SEP_8 = ev("a", "Peres de Almeida", "2026-09-08T17:00:00+01:00", "2026-09-08T20:30:00+01:00");
const OUT = ev("b", "Peres de Almeida out", "2026-09-28T00:00:00Z", "2026-10-01T00:00:00Z", true);
const BIA = ev("c", "Bia", "2026-09-21T08:00:00+01:00", "2026-09-21T11:00:00+01:00");
const FUTURE = ev("d", "Peres de Almeida", "2026-10-03T09:00:00+01:00", "2026-10-03T13:00:00+01:00");
const AUGUST = ev("e", "Peres de Almeida", "2026-08-30T09:00:00+01:00", "2026-08-30T13:00:00+01:00");
const TOO_FAR = ev("f", "Peres de Almeida", "2027-03-02T08:30:00Z", "2027-03-02T11:30:00Z");

describe("syncUntil", () => {
  it("ends after the 4th month ahead", () => {
    expect(syncUntil(NOW).toISOString()).toBe("2027-03-01T00:00:00.000Z");
  });
});

describe("rowsToSync", () => {
  it("keeps every timed event from September to the end of the window, worked or scheduled, whatever its title (the rule is in the studio view)", () => {
    const rows = rowsToSync([SEP_8, OUT, BIA, FUTURE, AUGUST, TOO_FAR], syncUntil(NOW));
    expect(rows.map((r) => r.event_id)).toEqual(["a", "c", "d"]);
    expect(rows[0]).toEqual({
      event_id: "a",
      calendar_id: "rececao",
      title: "Peres de Almeida",
      start_at: "2026-09-08T16:00:00.000Z",
      end_at: "2026-09-08T19:30:00.000Z",
    });
  });
});

describe("run", () => {
  beforeEach(() => {
    listCalendarEventsStrict.mockReset();
    clientQuery.mockReset().mockResolvedValue({ rowCount: 0 });
    withTransaction.mockClear();
  });

  it("upserts the rows and deletes what the calendar no longer has", async () => {
    listCalendarEventsStrict.mockResolvedValue([SEP_8, BIA, FUTURE]);
    await run(NOW);
    expect(listCalendarEventsStrict.mock.calls[0][2]).toEqual(syncUntil(NOW));
    expect(clientQuery).toHaveBeenCalledTimes(4);
    const [deleteSql, deleteParams] = clientQuery.mock.calls[3];
    expect(deleteSql).toMatch(/delete from reception_calendar_events/);
    expect(deleteParams).toEqual([["a", "c", "d"]]);
  });

  it("writes and deletes nothing when the calendar can't be read", async () => {
    listCalendarEventsStrict.mockRejectedValue(new Error("calendar: no calendar named \"Receção\""));
    await run(NOW);
    expect(withTransaction).not.toHaveBeenCalled();
  });

  it("writes and deletes nothing when the calendar comes back empty", async () => {
    listCalendarEventsStrict.mockResolvedValue([OUT, AUGUST]);
    await run(NOW);
    expect(withTransaction).not.toHaveBeenCalled();
  });
});
