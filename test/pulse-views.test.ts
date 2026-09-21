import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  activeMembersAsOf,
  computeDataAsOf,
  continuousSince,
  isPulseView,
  memberIdFromEmail,
  type MembershipStateRow,
} from "../src/lib/pulse-views.js";

// Real v_pulse_membership_state rows as of the 2026-09-18 Kenko import
// (pulled 2026-09-21). Hashes and dates only — member_id is
// md5(lower(email)), the views' own key — so nothing personal is in git.
const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/v_pulse_membership_state.2026-09-18.json", import.meta.url), "utf8"),
) as MembershipStateRow[];

// The three people the spec names (docs/plans/2026-09-21-pulse-views-spec.md).
const ESEN = "960b7be6db6b79e0694af7d77db8bf2e"; // paused 14-30 Sep — case #1
const ANDREIA = "5b0d6fca37b9caf98d42520a37e6c58a"; // cancellation scheduled 9 Oct — case #5
const MADALENA_ALMEIDA = "15ea0974c59a6a35b0efd890fa87b353"; // staff — case #11

describe("memberIdFromEmail", () => {
  it("is md5(lower(email)) with no trim, matching the view SQL", () => {
    expect(memberIdFromEmail("Sofia@Example.com")).toBe(memberIdFromEmail("sofia@example.com"));
    expect(memberIdFromEmail(" a@b.c")).not.toBe(memberIdFromEmail("a@b.c"));
    expect(memberIdFromEmail("a@b.c")).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe("computeDataAsOf", () => {
  it("is the latest cycle start on or before today — 2026-09-18 on the pinned snapshot", () => {
    expect(computeDataAsOf(fixture, "2026-09-21")).toBe("2026-09-18");
  });

  it("ignores cycle starts after today (a pre-scheduled renewal is not data)", () => {
    expect(
      computeDataAsOf([{ cycle_starts_at: "2026-10-01" }, { cycle_starts_at: "2026-09-10" }], "2026-09-21"),
    ).toBe("2026-09-10");
  });

  it("returns null with no usable rows", () => {
    expect(computeDataAsOf([], "2026-09-21")).toBeNull();
    expect(computeDataAsOf([{ cycle_starts_at: null }], "2026-09-21")).toBeNull();
  });
});

describe("activeMembersAsOf — the spec's verification query, on real rows", () => {
  const active = activeMembersAsOf(fixture, "2026-09-18");

  it("counts 75 paying members on 2026-09-18", () => {
    expect(active.size).toBe(75);
  });

  it("leaves Esen Sekerkarar out (paused 14-30 Sep, case #1)", () => {
    expect(active.has(ESEN)).toBe(false);
  });

  it("keeps Andreia taboleiros in (cancellation scheduled 9 Oct is still paying, case #5)", () => {
    expect(active.has(ANDREIA)).toBe(true);
  });

  it("never sees staff — Madalena Almeida is not in the view at all (case #11)", () => {
    expect(fixture.some((r) => r.member_id === MADALENA_ALMEIDA)).toBe(false);
  });

  it("labels the plan the way existing Notion rows read it", () => {
    for (const m of active.values()) {
      expect(m.membershipName).toMatch(/^(4x|8x|12x|Unlimited) Monthly \| (Premium|Essentials)$/);
    }
  });
});

function cycle(
  memberId: string,
  start: string,
  end: string | null,
  extra: Partial<MembershipStateRow> = {},
): MembershipStateRow {
  return {
    member_id: memberId,
    tier: "4x",
    plan: "Premium",
    status: "Active",
    started: start,
    cycle_starts_at: start,
    cycle_expires_at: end,
    cycle_billing_ends_at: end,
    is_paying_cycle: true,
    is_paused: false,
    is_unpaid: false,
    churned_on: null,
    owes_dues: false,
    ...extra,
  };
}

describe("continuousSince", () => {
  it("walks back over back-to-back cycles to the first one", () => {
    const cycles = [
      cycle("m", "2026-06-01", "2026-07-01"),
      cycle("m", "2026-07-01", "2026-08-01"),
      cycle("m", "2026-08-01", "2026-09-01"),
    ];
    expect(continuousSince(cycles, cycles[2])).toBe("2026-06-01");
  });

  it("stops at a gap wider than 3 days (a win-back restarts tenure)", () => {
    const cycles = [cycle("m", "2026-01-01", "2026-02-01"), cycle("m", "2026-08-15", "2026-09-15")];
    expect(continuousSince(cycles, cycles[1])).toBe("2026-08-15");
  });

  it("tolerates a 1-2 day billing gap", () => {
    const cycles = [cycle("m", "2026-07-01", "2026-07-31"), cycle("m", "2026-08-02", "2026-09-02")];
    expect(continuousSince(cycles, cycles[1])).toBe("2026-07-01");
  });

  it("breaks the chain at a non-paying (paused) cycle", () => {
    const cycles = [
      cycle("m", "2026-06-01", "2026-07-01"),
      cycle("m", "2026-07-01", "2026-08-01", { is_paying_cycle: false, is_paused: true, status: "Paused" }),
      cycle("m", "2026-08-01", "2026-09-01"),
    ];
    expect(continuousSince(cycles, cycles[2])).toBe("2026-08-01");
  });
});

describe("activeMembersAsOf edge cases", () => {
  it("is empty when no cycle overlaps asOf", () => {
    expect(activeMembersAsOf([cycle("m", "2026-01-01", "2026-02-01")], "2026-09-18").size).toBe(0);
  });

  it("treats a null cycle_expires_at as open-ended", () => {
    expect(activeMembersAsOf([cycle("m", "2026-09-01", null)], "2026-09-18").has("m")).toBe(true);
  });

  it("skips non-paying cycles even when they overlap", () => {
    const rows = [cycle("m", "2026-09-01", "2026-10-01", { is_paying_cycle: false, is_paused: true })];
    expect(activeMembersAsOf(rows, "2026-09-18").size).toBe(0);
  });

  it("is inclusive on both cycle bounds (a cycle ending today still counts)", () => {
    expect(activeMembersAsOf([cycle("m", "2026-08-18", "2026-09-18")], "2026-09-18").has("m")).toBe(true);
  });

  it("uses the latest-starting live cycle when two overlap (plan change)", () => {
    const rows = [
      cycle("m", "2026-09-01", "2026-10-01", { tier: "4x" }),
      cycle("m", "2026-09-10", "2026-10-10", { tier: "8x" }),
    ];
    expect(activeMembersAsOf(rows, "2026-09-18").get("m")?.tier).toBe("8x");
  });
});

describe("isPulseView", () => {
  it("accepts v_pulse_* names only — nothing else reaches the regclass cast", () => {
    expect(isPulseView("v_pulse_paused_detail")).toBe(true);
    expect(isPulseView("kenko_customers")).toBe(false);
    expect(isPulseView("v_pulse_x; drop table y")).toBe(false);
  });
});
