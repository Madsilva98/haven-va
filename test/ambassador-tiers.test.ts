import { describe, expect, it } from "vitest";

import { isEmptyPlan, planAmbassadorTierChanges, suspiciousReason } from "../src/lib/ambassador-tiers.js";
import type { AmbassadorTierRow } from "../src/lib/pulse-views.js";
import { formatAmbassadorTierChanges, monthStartLabel } from "../src/messages/ambassador-tiers.js";

const LABELS = ["—", "10%", "15%", "50%", "2x por semana oferecida", "Ilimitado oferecido"];

function row(
  id: string,
  month: string,
  tier: number,
  active: number,
  opts: { member?: boolean; label?: string } = {},
): AmbassadorTierRow {
  return {
    month_start: month,
    ambassador_member_id: id,
    ambassador_is_member: opts.member ?? true,
    active_referred: active,
    tier,
    is_first_five: false,
    discount_label: opts.label ?? LABELS[tier]!,
    referred_member_ids: [],
  };
}

const OCT = "2026-10-01";
const NOV = "2026-11-01";
const DEC = "2026-12-01";
const NAMES = new Map([
  ["ana", "Ana Silva"],
  ["rita", "Rita Costa"],
  ["joana", "Joana Reis"],
  ["sofia", "Sofia Lopes"],
  ["marta", "Marta Dias"],
]);

describe("planAmbassadorTierChanges", () => {
  it("first count ever: everyone with a tier is new, tier 0 is left out", () => {
    const plan = planAmbassadorTierChanges([row("ana", NOV, 3, 4), row("rita", NOV, 1, 1), row("joana", NOV, 0, 0)], []);
    expect(plan.new.map((c) => c.memberId).sort()).toEqual(["ana", "rita"]);
    expect(plan.up).toEqual([]);
    expect(plan.down).toEqual([]);
    expect(plan.left).toEqual([]);
  });

  it("up and down carry both labels and this month's count", () => {
    const plan = planAmbassadorTierChanges(
      [row("ana", DEC, 3, 4), row("rita", DEC, 2, 3)],
      [row("ana", NOV, 2, 2), row("rita", NOV, 3, 4)],
    );
    expect(plan.up).toEqual([
      { memberId: "ana", fromTier: 2, toTier: 3, fromLabel: "15%", toLabel: "50%", activeReferred: 4, isMember: true },
    ]);
    expect(plan.down).toEqual([
      { memberId: "rita", fromTier: 3, toTier: 2, fromLabel: "50%", toLabel: "15%", activeReferred: 3, isMember: true },
    ]);
  });

  it("new in a later month: tier 0 (or absent) before and never tiered", () => {
    const plan = planAmbassadorTierChanges(
      [row("ana", DEC, 1, 1), row("joana", DEC, 1, 1)],
      [row("ana", NOV, 0, 0)],
    );
    expect(plan.new.map((c) => c.memberId).sort()).toEqual(["ana", "joana"]);
  });

  it("back to a tier after a month at 0 is up, not new", () => {
    const plan = planAmbassadorTierChanges([row("ana", DEC, 1, 1)], [row("ana", NOV, 0, 0)], [row("ana", OCT, 2, 2)]);
    expect(plan.new).toEqual([]);
    expect(plan.up.map((c) => [c.memberId, c.fromLabel, c.toLabel])).toEqual([["ana", null, "10%"]]);
  });

  it("left: fewer referrals down to 0", () => {
    const plan = planAmbassadorTierChanges([row("rita", DEC, 0, 0)], [row("rita", NOV, 1, 1)]);
    expect(plan.left).toEqual([
      { memberId: "rita", fromTier: 1, toTier: 0, fromLabel: "10%", toLabel: null, activeReferred: 0, isMember: true },
    ]);
  });

  it("left: the ambassador is no longer a member (tier 0 though referrals stay)", () => {
    const plan = planAmbassadorTierChanges([row("ana", DEC, 0, 4, { member: false })], [row("ana", NOV, 3, 4)]);
    expect(plan.left).toHaveLength(1);
    expect(plan.left[0]).toMatchObject({ memberId: "ana", isMember: false, fromLabel: "50%", activeReferred: 4 });
  });

  it("left: tiered last month and missing from this month's rows", () => {
    const plan = planAmbassadorTierChanges([], [row("ana", NOV, 2, 2)]);
    expect(plan.left).toMatchObject([{ memberId: "ana", fromLabel: "15%", isMember: false }]);
  });

  it("no change: same tier (even with a different count) is silent", () => {
    const plan = planAmbassadorTierChanges(
      [row("ana", DEC, 2, 3), row("joana", DEC, 0, 0)],
      [row("ana", NOV, 2, 2), row("joana", NOV, 0, 0)],
    );
    expect(isEmptyPlan(plan)).toBe(true);
  });

  it("first five: the label comes from the view, never recomputed", () => {
    const plan = planAmbassadorTierChanges([row("ana", NOV, 1, 1, { label: "15%" })], []);
    expect(plan.new[0]!.toLabel).toBe("15%");
  });
});

describe("suspiciousReason", () => {
  it("never trips on the first count", () => {
    const now = ["ana", "rita", "joana", "sofia", "marta"].map((id) => row(id, NOV, 1, 1));
    expect(suspiciousReason(planAmbassadorTierChanges(now, []), now, [])).toBeNull();
  });

  it("trips when more than half the tiered ambassadors move", () => {
    const ids = ["ana", "rita", "joana", "sofia", "marta", "eva"];
    const last = ids.map((id) => row(id, NOV, 2, 2));
    const now = ids.map((id, i) => row(id, DEC, i < 4 ? 1 : 2, i < 4 ? 1 : 2));
    expect(suspiciousReason(planAmbassadorTierChanges(now, last), now, last)).toMatch(/4 dos 6/);
    const fewer = ids.map((id, i) => row(id, DEC, i < 3 ? 1 : 2, i < 3 ? 1 : 2));
    expect(suspiciousReason(planAmbassadorTierChanges(fewer, last), fewer, last)).toBeNull();
  });

  it("does not trip on a small list under the minimum", () => {
    const last = [row("ana", NOV, 2, 2), row("rita", NOV, 2, 2)];
    const now = [row("ana", DEC, 1, 1), row("rita", DEC, 3, 4)];
    expect(suspiciousReason(planAmbassadorTierChanges(now, last), now, last)).toBeNull();
  });

  it("trips when the view comes back empty after a month with tiers", () => {
    const last = [row("ana", NOV, 2, 2)];
    expect(suspiciousReason(planAmbassadorTierChanges([], last), [], last)).toMatch(/sem nenhum embaixador/);
    const zeros = [row("ana", DEC, 0, 0)];
    expect(suspiciousReason(planAmbassadorTierChanges(zeros, last), zeros, last)).toMatch(/sem nenhum embaixador/);
  });
});

describe("formatAmbassadorTierChanges", () => {
  it("is null when nothing changed", () => {
    expect(formatAmbassadorTierChanges({ up: [], down: [], new: [], left: [] }, DEC, NAMES)).toBeNull();
  });

  it("formats every section, names sorted, plain text", () => {
    const plan = planAmbassadorTierChanges(
      [
        row("ana", DEC, 3, 4),
        row("rita", DEC, 2, 3),
        row("joana", DEC, 1, 1),
        row("sofia", DEC, 0, 0),
        row("marta", DEC, 0, 2, { member: false }),
      ],
      [row("ana", NOV, 2, 2), row("rita", NOV, 3, 4), row("sofia", NOV, 1, 1), row("marta", NOV, 2, 2)],
    );
    expect(formatAmbassadorTierChanges(plan, DEC, NAMES)).toBe(
      [
        "Embaixadores · contagem de 1 de dezembro",
        "",
        "Subiram",
        "· Ana Silva: 15% → 50% (4 pessoas)",
        "",
        "Desceram",
        "· Rita Costa: 50% → 15% (3 pessoas)",
        "",
        "Novos",
        "· Joana Reis: 10% (1 pessoa)",
        "",
        "Deixam de ter desconto",
        "· Marta Dias: 15% → sem desconto (já não é membro)",
        "· Sofia Lopes: 10% → sem desconto (0 pessoas)",
        "",
        "A Bia muda o desconto no Kenko no próximo pagamento de cada pessoa.",
      ].join("\n"),
    );
  });

  it("first month: only Novos", () => {
    const plan = planAmbassadorTierChanges([row("ana", NOV, 3, 5), row("joana", NOV, 1, 1)], []);
    const text = formatAmbassadorTierChanges(plan, NOV, NAMES)!;
    expect(text.startsWith("Embaixadores · contagem de 1 de novembro\n\nNovos\n· Ana Silva: 50% (5 pessoas)\n· Joana Reis: 10% (1 pessoa)")).toBe(true);
    expect(text).not.toMatch(/Subiram|Desceram|Deixam/);
  });

  it("an ambassador without a name in the identity view still shows", () => {
    const plan = planAmbassadorTierChanges([row("abcdef1234567890", NOV, 1, 1)], []);
    expect(formatAmbassadorTierChanges(plan, NOV, new Map())).toContain("· sem nome (abcdef12): 10% (1 pessoa)");
  });

  it("monthStartLabel", () => {
    expect(monthStartLabel("2027-01-01")).toBe("1 de janeiro");
  });
});
