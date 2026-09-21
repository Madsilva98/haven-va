import { describe, expect, it } from "vitest";

import {
  computeChurnFlags,
  fullMonthsBefore,
  type ActiveSubscriber,
  type ChurnInputs,
} from "../src/lib/churn-signals.js";
import type { FailedPaymentsRow, MemberActivityRow, UtilizationMonthRow } from "../src/lib/pulse-views.js";

const AS_OF = "2026-09-18";

function member(memberId: string, membershipName = "4x Monthly | Premium", memberSince = "2026-01-01"): ActiveSubscriber {
  return { memberId, email: `${memberId}@x.com`, name: memberId, membershipName, memberSince };
}

function activity(memberId: string, nextOrLastBooked: string | null, lastVisit: string | null = nextOrLastBooked): MemberActivityRow {
  return {
    member_id: memberId,
    first_visit: lastVisit,
    last_visit: lastVisit,
    visit_count: lastVisit ? 1 : 0,
    last_booked: nextOrLastBooked && nextOrLastBooked <= AS_OF ? nextOrLastBooked : null,
    next_or_last_booked: nextOrLastBooked,
  };
}

function util(memberId: string, month: string, pct: number | null, over: Partial<UtilizationMonthRow> = {}): UtilizationMonthRow {
  return {
    member_id: memberId,
    month,
    tier: pct === null ? "Unlimited" : "4x",
    allowance: pct === null ? null : 4,
    attended: pct === null ? 9 : Math.round((pct / 100) * 4),
    utilization_pct: pct,
    had_pause: false,
    in_progress: false,
    ...over,
  };
}

function inputs(over: Partial<ChurnInputs>): ChurnInputs {
  return {
    asOf: AS_OF,
    members: [],
    activityByMember: new Map(),
    failedByMember: new Map(),
    utilization: [],
    pauseHistory: [],
    ...over,
  };
}

const types = (flags: ReturnType<typeof computeChurnFlags>, memberId: string) =>
  flags.find((f) => f.email === `${memberId}@x.com`)?.signals.map((s) => s.type) ?? [];

describe("fullMonthsBefore", () => {
  it("lists the 3 full calendar months before the data date's month, most recent first", () => {
    expect(fullMonthsBefore("2026-09-18", 3)).toEqual(["2026-08-01", "2026-07-01", "2026-06-01"]);
    expect(fullMonthsBefore("2026-01-05", 2)).toEqual(["2025-12-01", "2025-11-01"]);
  });
});

describe("computeChurnFlags — signal 1, Sem reservas 14+ dias", () => {
  it("flags a long-tenured member whose last booked class is over 14 days back", () => {
    const flags = computeChurnFlags(
      inputs({ members: [member("a")], activityByMember: new Map([["a", activity("a", "2026-08-20")]]) }),
    );
    expect(types(flags, "a")).toEqual(["Sem reservas 14+ dias"]);
    expect(flags[0]!.signals[0]!.detail).toBe("29 dias sem reservar (última aula marcada: 20/08/2026)");
  });

  it("does not flag a member with a class booked in the future — a future booking is engagement", () => {
    const flags = computeChurnFlags(
      inputs({ members: [member("a")], activityByMember: new Map([["a", activity("a", "2026-09-25", "2026-08-01")]]) }),
    );
    expect(types(flags, "a")).toEqual([]);
  });

  it("does not flag a brand-new member (tenure < 14 days) with no booking yet", () => {
    const flags = computeChurnFlags(inputs({ members: [member("a", "4x Monthly | Premium", "2026-09-10")] }));
    expect(types(flags, "a")).toEqual([]);
  });

  it("flags a member who never booked since joining, once 14 days have passed", () => {
    const flags = computeChurnFlags(inputs({ members: [member("a", "4x Monthly | Premium", "2026-08-01")] }));
    expect(flags[0]!.signals[0]!.detail).toBe("48 dias sem nenhuma reserva desde a inscrição");
  });

  it("measures from the end of a pause, not from a stale pre-pause booking (Sofia Barata case)", () => {
    const flags = computeChurnFlags(
      inputs({
        members: [member("sofia", "8x Monthly | Premium", "2026-03-01")],
        activityByMember: new Map([["sofia", activity("sofia", "2026-07-20")]]),
        pauseHistory: [{ member_id: "sofia", cycle_end: "2026-08-27" }],
      }),
    );
    expect(flags[0]!.signals[0]!.detail).toBe("22 dias sem reservar desde que voltou da pausa (27/08/2026)");
  });

  it("does not let a pause that ended less than 14 days ago flag anyone", () => {
    const flags = computeChurnFlags(
      inputs({
        members: [member("a")],
        activityByMember: new Map([["a", activity("a", "2026-06-01")]]),
        pauseHistory: [{ member_id: "a", cycle_end: "2026-09-10" }],
      }),
    );
    expect(types(flags, "a")).toEqual([]);
  });

  it("ignores a pause cycle that ends after the data date (still paused = not on the roster anyway)", () => {
    const flags = computeChurnFlags(
      inputs({
        members: [member("a")],
        activityByMember: new Map([["a", activity("a", "2026-08-01")]]),
        pauseHistory: [{ member_id: "a", cycle_end: "2026-10-15" }],
      }),
    );
    expect(types(flags, "a")).toEqual(["Sem reservas 14+ dias"]);
  });
});

describe("computeChurnFlags — signal 2, Pagamento falhado", () => {
  const failed = (memberId: string, failed45: number, last: string): [string, FailedPaymentsRow] => [
    memberId,
    { member_id: memberId, failed_45d: failed45, failed_ever: failed45 + 1, last_failed_on: last, last_failed_amount: 60 },
  ];

  it("flags a failed payment the view counts inside 45 days", () => {
    const flags = computeChurnFlags(
      inputs({
        members: [member("a")],
        activityByMember: new Map([["a", activity("a", "2026-09-17")]]),
        failedByMember: new Map([failed("a", 1, "2026-09-02")]),
      }),
    );
    expect(types(flags, "a")).toEqual(["Pagamento falhado"]);
    expect(flags[0]!.signals[0]!.detail).toBe("pagamento falhado a 02/09/2026");
  });

  it("ignores a member whose failures are all older than 45 days (failed_45d = 0)", () => {
    const flags = computeChurnFlags(
      inputs({
        members: [member("a")],
        activityByMember: new Map([["a", activity("a", "2026-09-17")]]),
        failedByMember: new Map([failed("a", 0, "2026-05-02")]),
      }),
    );
    expect(types(flags, "a")).toEqual([]);
  });
});

describe("computeChurnFlags — signal 3, Baixa utilização", () => {
  const engaged = (id: string) => new Map([[id, activity(id, "2026-09-17")]]);

  it("flags under 50% in each of the last 3 full months for a long-tenured member", () => {
    const flags = computeChurnFlags(
      inputs({
        members: [member("a")],
        activityByMember: engaged("a"),
        utilization: [util("a", "2026-06-01", 25), util("a", "2026-07-01", 0), util("a", "2026-08-01", 25), util("a", "2026-09-01", 0, { in_progress: true })],
      }),
    );
    expect(types(flags, "a")).toEqual(["Baixa utilização"]);
    expect(flags[0]!.signals[0]!.detail).toBe("17% de utilização média nos últimos 3 meses (jun.: 25%, jul.: 0%, ago.: 25%)");
  });

  it("does not flag when one of the three months is at or above 50%", () => {
    const flags = computeChurnFlags(
      inputs({
        members: [member("a")],
        activityByMember: engaged("a"),
        utilization: [util("a", "2026-06-01", 25), util("a", "2026-07-01", 50), util("a", "2026-08-01", 25)],
      }),
    );
    expect(types(flags, "a")).toEqual([]);
  });

  it("does not flag a member who was not a member for the whole window (the found-and-fixed bug)", () => {
    const flags = computeChurnFlags(
      inputs({
        members: [member("a", "4x Monthly | Premium", "2026-07-15")],
        activityByMember: engaged("a"),
        utilization: [util("a", "2026-07-01", 0), util("a", "2026-08-01", 25)],
      }),
    );
    expect(types(flags, "a")).toEqual([]);
  });

  it("skips a month the view marks had_pause (Raquel Saraiva case) — and so never reaches 3 clean months", () => {
    const flags = computeChurnFlags(
      inputs({
        members: [member("a")],
        activityByMember: engaged("a"),
        utilization: [util("a", "2026-06-01", 0, { had_pause: true }), util("a", "2026-07-01", 0), util("a", "2026-08-01", 0)],
      }),
    );
    expect(types(flags, "a")).toEqual([]);
  });

  it("does not evaluate Unlimited plans (allowance NULL)", () => {
    const flags = computeChurnFlags(
      inputs({
        members: [member("a", "Unlimited | Premium")],
        activityByMember: engaged("a"),
        utilization: [util("a", "2026-06-01", null), util("a", "2026-07-01", null), util("a", "2026-08-01", null)],
      }),
    );
    expect(types(flags, "a")).toEqual([]);
  });

  it("anchors the 3-month window to the data date, not the calendar", () => {
    // Data as of 2 Sep: the window is Jun-Aug, and the view's in_progress
    // flag (calendar) does not matter for months before that.
    const flags = computeChurnFlags(
      inputs({
        asOf: "2026-09-02",
        members: [member("a")],
        activityByMember: new Map([["a", activity("a", "2026-09-01")]]),
        utilization: [util("a", "2026-06-01", 25), util("a", "2026-07-01", 25), util("a", "2026-08-01", 25)],
      }),
    );
    expect(types(flags, "a")).toEqual(["Baixa utilização"]);
  });
});

describe("computeChurnFlags — roster", () => {
  it("has no staff list of its own: a thehavenpilates.pt member passed in is evaluated like anyone else (the views exclude staff)", () => {
    const staff: ActiveSubscriber = { ...member("x"), email: "x@thehavenpilates.pt" };
    const flags = computeChurnFlags(inputs({ members: [staff] }));
    expect(flags.some((f) => f.email === "x@thehavenpilates.pt")).toBe(true);
  });

  it("carries the plan label and a null phone for the cron to fill in", () => {
    const flags = computeChurnFlags(inputs({ members: [member("a", "8x Monthly | Essentials")] }));
    expect(flags[0]).toMatchObject({ plano: "8x Monthly | Essentials", telefone: null, name: "a" });
  });
});
