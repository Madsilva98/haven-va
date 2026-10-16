import { describe, expect, it } from "vitest";

import {
  buildSnapshot,
  effectIfScheduledLeave,
  effectOnNextCount,
  isAtRisk,
  nextCountLabel,
  planAmbassadorNews,
  suspiciousImportReason,
  tierForCount,
  type Snapshot,
} from "../src/lib/ambassador-watch.js";
import type { AmbassadorReferralRow, AmbassadorTierScaleRow, MembershipStatusRow } from "../src/lib/pulse-views.js";
import { formatAmbassadorMessage, type NewsLine } from "../src/messages/ambassador-tiers.js";

function ref(amb: string, referred: string, opts: { counts?: boolean; excluded?: string } = {}): AmbassadorReferralRow {
  return {
    ambassador_member_id: amb,
    referred_member_id: referred,
    referred_on: "2026-10-20",
    is_new: true,
    first_membership_on: "2026-10-20",
    active_on_data_as_of: opts.counts ?? true,
    excluded_reason: opts.excluded ?? null,
  };
}
const status = (id: string, s: string, covers = true): [string, MembershipStatusRow] => [id, { member_id: id, status: s, covers }];

const SCALE: AmbassadorTierScaleRow[] = [
  { tier: 0, min_referred: 0, max_referred: 0, discount_label: "—", first_five_label: "—" },
  { tier: 1, min_referred: 1, max_referred: 1, discount_label: "10%", first_five_label: "15%" },
  { tier: 2, min_referred: 2, max_referred: 3, discount_label: "15%", first_five_label: "20%" },
  { tier: 3, min_referred: 4, max_referred: 5, discount_label: "50%", first_five_label: "50%" },
  { tier: 4, min_referred: 6, max_referred: 10, discount_label: "2x por semana oferecida", first_five_label: "2x por semana oferecida" },
  { tier: 5, min_referred: 11, max_referred: null, discount_label: "Ilimitado oferecido", first_five_label: "Ilimitado oferecido" },
];
const NAMES = new Map([
  ["ana", "Ana Silva"],
  ["rita", "Rita Costa"],
  ["eva", "Eva Matos"],
  ["marta", "Marta Dias"],
  ["joana", "Joana Reis"],
]);

describe("buildSnapshot", () => {
  it("counts only the view's counting referrals and flags scheduled cancellations", () => {
    const statuses = new Map([status("ana", "Active"), status("rita", "Active"), status("eva", "Cancelation scheduled")]);
    const snap = buildSnapshot(
      [ref("ana", "rita"), ref("ana", "eva"), ref("ana", "marta", { excluded: "no_purchase", counts: false })],
      statuses,
    );
    expect(snap).toEqual({
      ana: { counting: ["eva", "rita"], cancelScheduled: ["eva"], selfMember: true, selfCancelScheduled: false },
    });
  });

  it("an ambassador on pause is still a member", () => {
    const snap = buildSnapshot([ref("ana", "rita")], new Map([status("ana", "Paused")]));
    expect(snap.ana!.selfMember).toBe(true);
  });
});

describe("planAmbassadorNews", () => {
  const base: Snapshot = { ana: { counting: ["rita"], cancelScheduled: [], selfMember: true, selfCancelScheduled: false } };

  it("the first import ever is a baseline: no news", () => {
    expect(planAmbassadorNews(null, base, new Map())).toEqual([]);
  });

  it("someone enters (even with no tier change)", () => {
    const now: Snapshot = { ana: { ...base.ana!, counting: ["eva", "rita"] } };
    expect(planAmbassadorNews(base, now, new Map())).toMatchObject([{ ambassadorId: "ana", entered: ["eva"], left: [], countNow: 2 }]);
  });

  it("someone leaves, with the reason from their membership", () => {
    const now: Snapshot = { ana: { ...base.ana!, counting: [] } };
    expect(planAmbassadorNews(base, now, new Map([status("rita", "Canceled", false)]))[0]!.left).toEqual([
      { id: "rita", reason: "cancelou" },
    ]);
    expect(planAmbassadorNews(base, now, new Map([status("rita", "Expired", false)]))[0]!.left[0]!.reason).toBe("expirou");
    expect(planAmbassadorNews(base, now, new Map([status("rita", "Paused")]))[0]!.left[0]!.reason).toBe("pausou");
  });

  it("a newly scheduled cancellation is news once", () => {
    const scheduled: Snapshot = { ana: { ...base.ana!, cancelScheduled: ["rita"] } };
    expect(planAmbassadorNews(base, scheduled, new Map())[0]!.cancelScheduled).toEqual(["rita"]);
    expect(planAmbassadorNews(scheduled, scheduled, new Map())).toEqual([]);
  });

  it("the ambassador's own cancellation and exit, only with someone counting", () => {
    const selfCancel: Snapshot = { ana: { ...base.ana!, selfCancelScheduled: true } };
    expect(planAmbassadorNews(base, selfCancel, new Map())[0]!.selfCancelScheduled).toBe(true);
    const gone: Snapshot = { ana: { ...base.ana!, selfMember: false } };
    expect(planAmbassadorNews(base, gone, new Map())[0]!.selfLeft).toBe(true);
    const noStake: Snapshot = { joana: { counting: [], cancelScheduled: [], selfMember: true, selfCancelScheduled: false } };
    expect(planAmbassadorNews(noStake, { joana: { ...noStake.joana!, selfMember: false } }, new Map())).toEqual([]);
  });

  it("no change: no news", () => {
    expect(planAmbassadorNews(base, base, new Map())).toEqual([]);
  });
});

describe("suspiciousImportReason", () => {
  it("trips when more than half the people counting leave at once", () => {
    const prev: Snapshot = { ana: { counting: ["a", "b", "c", "d", "e", "f"], cancelScheduled: [], selfMember: true, selfCancelScheduled: false } };
    const now: Snapshot = { ana: { ...prev.ana!, counting: ["a", "b"] } };
    expect(suspiciousImportReason(prev, planAmbassadorNews(prev, now, new Map()))).toMatch(/4 das 6/);
    const fewer: Snapshot = { ana: { ...prev.ana!, counting: ["a", "b", "c"] } };
    expect(suspiciousImportReason(prev, planAmbassadorNews(prev, fewer, new Map()))).toBeNull();
  });
});

describe("tiers and effects", () => {
  it("tierForCount reads the scale, first five included", () => {
    expect(tierForCount(SCALE, 3, false)).toEqual({ tier: 2, label: "15%" });
    expect(tierForCount(SCALE, 1, true)).toEqual({ tier: 1, label: "15%" });
    expect(tierForCount(SCALE, 0, false)).toEqual({ tier: 0, label: null });
    expect(tierForCount(SCALE, 12, false)).toEqual({ tier: 5, label: "Ilimitado oferecido" });
    expect(tierForCount(null, 3, false)).toBeNull();
  });

  it("nextCountLabel wraps the year", () => {
    expect(nextCountLabel("2026-11-14")).toBe("1 de dezembro");
    expect(nextCountLabel("2026-12-03")).toBe("1 de janeiro");
  });

  it("effectOnNextCount", () => {
    const asOf = "2026-11-14";
    expect(effectOnNextCount({ tier: 2, label: "15%" }, { tier: 3, label: "50%" }, asOf)).toBe(
      "Sobe de 15% para 50% na contagem de 1 de dezembro.",
    );
    expect(effectOnNextCount({ tier: 2, label: "15%" }, { tier: 1, label: "10%" }, asOf)).toBe(
      "Desce de 15% para 10% na contagem de 1 de dezembro.",
    );
    expect(effectOnNextCount({ tier: 0, label: null }, { tier: 1, label: "10%" }, asOf)).toBe(
      "Passa a ter 10% na contagem de 1 de dezembro.",
    );
    expect(effectOnNextCount({ tier: 2, label: "15%" }, { tier: 2, label: "15%" }, asOf)).toBe("Mantém 15%.");
    expect(effectOnNextCount({ tier: 1, label: "10%" }, { tier: 0, label: null }, asOf)).toBe(
      "Desce de 10% para sem desconto na contagem de 1 de dezembro.",
    );
    expect(effectOnNextCount({ tier: 2, label: "15%" }, null, asOf)).toBeNull();
  });

  it("effectIfScheduledLeave", () => {
    expect(effectIfScheduledLeave(SCALE, { tier: 2, label: "15%" }, 3, 1, false)).toBe("Se sair, mantém 15%.");
    expect(effectIfScheduledLeave(SCALE, { tier: 2, label: "15%" }, 2, 1, false)).toBe("Se sair, desce para 10%.");
    expect(effectIfScheduledLeave(SCALE, { tier: 1, label: "10%" }, 1, 1, false)).toBe("Se sair, desce para sem desconto.");
    expect(effectIfScheduledLeave(null, { tier: 2, label: "15%" }, 2, 1, false)).toBeNull();
  });

  it("isAtRisk", () => {
    const a = { counting: ["r", "e"], cancelScheduled: [], selfMember: true, selfCancelScheduled: false };
    expect(isAtRisk(a, { tier: 2, label: "15%" }, { tier: 2, label: "15%" }, 2)).toBe(false);
    expect(isAtRisk(a, { tier: 3, label: "50%" }, { tier: 2, label: "15%" }, 4)).toBe(true);
    expect(isAtRisk({ ...a, cancelScheduled: ["r"] }, { tier: 2, label: "15%" }, { tier: 2, label: "15%" }, 2)).toBe(true);
    // Without today's view: a lower count than at the last 1st.
    expect(isAtRisk(a, { tier: 2, label: "15%" }, null, 3)).toBe(true);
  });
});

describe("formatAmbassadorMessage (news between imports)", () => {
  const line = (n: Partial<NewsLine["news"]>, effect: string | null = null, scheduledEffect: string | null = null): NewsLine => ({
    news: { ambassadorId: "ana", entered: [], left: [], cancelScheduled: [], selfCancelScheduled: false, selfLeft: false, countNow: 0, ...n },
    effect,
    scheduledEffect,
    nextCount: "1 de dezembro",
  });

  it("informative part and action part in one message", () => {
    const text = formatAmbassadorMessage({
      asOf: "2026-11-14",
      names: NAMES,
      monthly: null,
      news: [
        line({ ambassadorId: "ana", entered: ["rita"], countNow: 4 }, "Sobe de 15% para 50% na contagem de 1 de dezembro."),
        line({ ambassadorId: "joana", cancelScheduled: ["marta"], countNow: 3 }, "Mantém 15%.", "Se sair, mantém 15%."),
        line({ ambassadorId: "eva", left: [{ id: "rita", reason: "cancelou" }], countNow: 1 }, "Desce de 15% para 10% na contagem de 1 de dezembro."),
      ],
    });
    expect(text).toBe(
      [
        "Embaixadores · dados até 14/11/2026",
        "",
        "O que mudou",
        "· Ana Silva: entrou Rita Costa → 4 pessoas. Sobe de 15% para 50% na contagem de 1 de dezembro.",
        "· Eva Matos: saiu Rita Costa (cancelou) → 1 pessoa. Desce de 15% para 10% na contagem de 1 de dezembro.",
        "· Joana Reis: Marta Dias agendou o cancelamento → 3 pessoas por agora. Se sair, mantém 15%.",
        "",
        "A fazer",
        "· Avisar Ana Silva: entrou Rita Costa",
        "· Avisar Eva Matos: saiu Rita Costa",
        "· Avisar Joana Reis: Marta Dias agendou o cancelamento",
      ].join("\n"),
    );
  });

  it("without today's tier: no effect sentence, the count still shows", () => {
    const text = formatAmbassadorMessage({ asOf: "2026-11-14", names: NAMES, monthly: null, news: [line({ entered: ["rita", "eva"], countNow: 2 })] })!;
    expect(text).toContain("· Ana Silva: entraram Rita Costa e Eva Matos → 2 pessoas.");
  });

  it("the ambassador's own membership: informative only, nothing to tell", () => {
    const text = formatAmbassadorMessage({ asOf: "2026-11-14", names: NAMES, monthly: null, news: [line({ selfCancelScheduled: true, countNow: 2 })] })!;
    expect(text).toContain(
      "· Ana Silva agendou o cancelamento da própria membership: perde o desconto se não renovar até 1 de dezembro.",
    );
    expect(text).not.toContain("A fazer");
  });

  it("nothing new: null", () => {
    expect(formatAmbassadorMessage({ asOf: "2026-11-14", names: NAMES, monthly: null, news: [] })).toBeNull();
  });
});
