import { describe, expect, it } from "vitest";

import { nextEstado, planIntroTracking, type Person } from "../src/lib/intro-pack-tracking.js";
import type { IntroPackTrackingRow } from "../src/lib/pulse-views.js";
import { formatIntroTrackingDigest } from "../src/messages/intro-pack-tracking.js";
import type { IntroTrackingRow } from "../src/types.js";

function viewRow(over: Partial<IntroPackTrackingRow> = {}): IntroPackTrackingRow {
  return {
    member_id: "m1",
    email: "ana@x.com",
    item_name: "2 Classes | Premium",
    pack: "2-Class",
    bought_on: "2026-09-14",
    first_class_on: "2026-09-18",
    expires_on: "2026-10-02",
    ended_on: "2026-09-25",
    visits_in_pack: 2,
    booked_ahead: 0,
    outcome: "maturing",
    data_as_of: "2026-10-02",
    auto_state: null,
    is_lead: false,
    days_since_end: 7,
    is_recent: true,
    reason: "pack_ended",
    reasons: ["pack_ended"],
    ...over,
  };
}

function notionRow(over: Partial<IntroTrackingRow> = {}): IntroTrackingRow {
  return {
    id: "page-1",
    memberId: "m1",
    nome: "Ana",
    estado: "A contactar",
    motivos: ["Pack ended"],
    aulasFeitas: 2,
    aulasMarcadas: 0,
    inicio: "2026-09-18",
    fim: "2026-09-25",
    ...over,
  };
}

const people = new Map<string, Person>([["m1", { name: "Ana Silva", phone: "+351 900" }]]);

describe("nextEstado", () => {
  it("a membership wins over any Estado, even Perdido", () => {
    expect(nextEstado("Perdido", "converted")).toBe("Convertido");
    expect(nextEstado("Contactado", "converted")).toBe("Convertido");
    expect(nextEstado("Convertido", "converted")).toBeNull();
  });

  it("a class pack wins too, but never over Convertido", () => {
    expect(nextEstado("Contactado", "bought_other")).toBe("Comprou outra coisa");
    expect(nextEstado("Convertido", "bought_other")).toBeNull();
  });

  it("cold lead / idle only close an open row — a founder's Perdido stays", () => {
    expect(nextEstado("A contactar", "cold_lead")).toBe("Cold lead");
    expect(nextEstado("Contactado", "cold_lead")).toBe("Cold lead");
    expect(nextEstado("Perdido", "cold_lead")).toBeNull();
    expect(nextEstado("A contactar", "idle")).toBe("Idle");
    expect(nextEstado("Perdido", "idle")).toBeNull();
  });

  it("Follow up is open like Contactado: it can go cold or idle, and a purchase wins (2026-10-05)", () => {
    expect(nextEstado("Follow up", "cold_lead")).toBe("Cold lead");
    expect(nextEstado("Follow up", "idle")).toBe("Idle");
    expect(nextEstado("Follow up", "converted")).toBe("Convertido");
    expect(nextEstado("Follow up", null)).toBeNull();
  });

  it("no auto_state leaves the Estado alone", () => {
    expect(nextEstado("Contactado", null)).toBeNull();
  });
});

describe("planIntroTracking", () => {
  it("adds someone who belongs on the list and is not there yet", () => {
    const plan = planIntroTracking([viewRow()], [], people);
    expect(plan.creates).toEqual([
      {
        memberId: "m1",
        name: "Ana Silva",
        fields: expect.objectContaining({ motivos: ["Pack ended"], pack: "2-Class", aulasFeitas: 2, telefone: "+351 900" }),
      },
    ]);
    expect(plan.updates).toEqual([]);
  });

  it("a 10-Day pack can be Underused and Pack ending on the same day — both are kept (2026-10-03)", () => {
    const plan = planIntroTracking(
      [viewRow({ pack: "10-Day", visits_in_pack: 2, reason: "pack_ending", reasons: ["underused", "pack_ending"] })],
      [],
      people,
    );
    expect(plan.creates[0]!.fields.motivos).toEqual(["Underused pack", "Pack ending"]);
  });

  it("never adds a person twice, whatever their Estado — a stale import repeats the same rows", () => {
    for (const estado of ["A contactar", "Perdido", "Cold lead", "Idle"] as const) {
      const plan = planIntroTracking([viewRow()], [notionRow({ estado })], people);
      expect(plan.creates).toEqual([]);
    }
  });

  it("does not write at all when nothing changed", () => {
    const plan = planIntroTracking([viewRow()], [notionRow()], people);
    expect(plan.updates).toEqual([]);
    expect(plan.newMotivos).toEqual([]);
  });

  it("Motivo follows today: a new reason is shown and announced, one that no longer applies goes (Jacqueline, 2026-10-05)", () => {
    // 2-Class: 1 class, ending → used the 2nd class on the last day → pack over.
    const plan = planIntroTracking(
      [viewRow({ reasons: ["pack_ended"] })],
      [notionRow({ motivos: ["Pack ending"] })],
      people,
    );
    expect(plan.updates).toHaveLength(1);
    expect(plan.updates[0]!.estado).toBeUndefined();
    expect(plan.updates[0]!.fields.motivos).toEqual(["Pack ended"]);
    expect(plan.newMotivos).toEqual([{ pageId: "page-1", name: "Ana", motivos: ["Pack ended"] }]);
  });

  it("keeps two reasons that are both true today (10-Day underused and ending)", () => {
    const plan = planIntroTracking(
      [viewRow({ pack: "10-Day", reasons: ["underused", "pack_ending"], visits_in_pack: 2 })],
      [notionRow({ motivos: ["Underused pack"] })],
      people,
    );
    expect(plan.updates[0]!.fields.motivos).toEqual(["Underused pack", "Pack ending"]);
    expect(plan.newMotivos).toEqual([{ pageId: "page-1", name: "Ana", motivos: ["Pack ending"] }]);
  });

  it("a Follow up row follows today's reasons and announces a new one", () => {
    const plan = planIntroTracking(
      [viewRow({ reasons: ["pack_ended"] })],
      [notionRow({ estado: "Follow up", motivos: ["Pack ending"] })],
      people,
    );
    expect(plan.updates[0]!.fields.motivos).toEqual(["Pack ended"]);
    expect(plan.newMotivos).toHaveLength(1);
  });

  it("an open row with no reason today shows none — nothing announced", () => {
    const plan = planIntroTracking(
      [viewRow({ reasons: [], booked_ahead: 1 })],
      [notionRow({ motivos: ["Pack ending"] })],
      people,
    );
    expect(plan.updates[0]!.fields.motivos).toEqual([]);
    expect(plan.newMotivos).toEqual([]);
  });

  it("does not rewrite when only the order of the same reasons differs", () => {
    const plan = planIntroTracking(
      [viewRow({ reasons: ["underused", "pack_ending"] })],
      [notionRow({ motivos: ["Pack ending", "Underused pack"] })],
      people,
    );
    expect(plan.updates).toEqual([]);
  });

  it("a closed row keeps the Motivo it had when it closed, and nothing is announced", () => {
    const plan = planIntroTracking(
      [viewRow({ reasons: ["pack_ended"], booked_ahead: 1 })],
      [notionRow({ estado: "Perdido", motivos: ["Pack ending"] })],
      people,
    );
    expect(plan.updates[0]!.fields.motivos).toEqual(["Pack ending"]);
    expect(plan.newMotivos).toEqual([]);
  });

  it("a row closing on this run keeps its last Motivo (the reason it was on the list)", () => {
    const plan = planIntroTracking(
      [viewRow({ reasons: [], auto_state: "cold_lead" })],
      [notionRow({ motivos: ["Pack ended"] })],
      people,
    );
    expect(plan.updates[0]!.estado).toBe("Cold lead");
    expect(plan.updates[0]!.fields.motivos).toEqual(["Pack ended"]);
  });

  it("never creates a closed row — the first run is not a backfill of past intros", () => {
    const plan = planIntroTracking(
      [
        viewRow({ reasons: [], auto_state: "cold_lead" }),
        viewRow({ member_id: "m2", reasons: [], auto_state: "converted" }),
      ],
      [],
      people,
    );
    expect(plan.creates).toEqual([]);
  });

  it("announces only who converted to a membership among the exits", () => {
    const plan = planIntroTracking(
      [
        viewRow({ reasons: [], auto_state: "converted" }),
        viewRow({ member_id: "m2", reasons: [], auto_state: "bought_other" }),
      ],
      [notionRow({ estado: "Contactado" }), notionRow({ id: "page-2", memberId: "m2", nome: "Rita" })],
      people,
    );
    expect(plan.updates.map((u) => u.estado)).toEqual(["Convertido", "Comprou outra coisa"]);
    expect(plan.converted).toEqual(["Ana"]);
  });
});

describe("formatIntroTrackingDigest", () => {
  it("is silent when nothing is new", () => {
    expect(formatIntroTrackingDigest([], [], [])).toBeNull();
  });

  it("lists who joined, who gained a reason, and who converted", () => {
    const { creates } = planIntroTracking(
      [viewRow({ booked_ahead: 1, reasons: ["underused", "pack_ending"] })],
      [],
      people,
    );
    const text = formatIntroTrackingDigest(creates, ["Rita"], [{ pageId: "p", name: "Joana", motivos: ["Underused pack"] }])!;
    expect(text).toContain("Ana Silva — Underused pack + Pack ending, 2-Class, 2 aulas feita(s), 1 aula marcada(s) (+351 900)");
    expect(text).toContain("Já na lista — novo motivo");
    expect(text).toContain("• Joana — Underused pack");
    expect(text).toContain("Converteram para mensalidade");
    expect(text).toContain("• Rita");
  });
});
