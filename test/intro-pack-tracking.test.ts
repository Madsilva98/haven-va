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
    reason: "pack_ended",
    ...over,
  };
}

function notionRow(over: Partial<IntroTrackingRow> = {}): IntroTrackingRow {
  return {
    id: "page-1",
    memberId: "m1",
    nome: "Ana",
    estado: "A contactar",
    motivo: "Pack ended",
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
        fields: expect.objectContaining({ motivo: "Pack ended", pack: "2-Class", aulasFeitas: 2, telefone: "+351 900" }),
      },
    ]);
    expect(plan.updates).toEqual([]);
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
  });

  it("refreshes the numbers and moves Motivo to the latest reason, keeping Estado", () => {
    const plan = planIntroTracking(
      [viewRow({ pack: "10-Day", reason: "pack_ending", visits_in_pack: 3, booked_ahead: 2 })],
      [notionRow({ motivo: "Underused pack", aulasFeitas: 2 })],
      people,
    );
    expect(plan.updates).toHaveLength(1);
    expect(plan.updates[0]!.estado).toBeUndefined();
    expect(plan.updates[0]!.fields).toMatchObject({ motivo: "Pack ending", aulasFeitas: 3, aulasMarcadas: 2 });
  });

  it("a day with no reason keeps the last Motivo (it is not written)", () => {
    const plan = planIntroTracking([viewRow({ reason: null, booked_ahead: 1 })], [notionRow()], people);
    expect(plan.updates[0]!.fields.motivo).toBeUndefined();
  });

  it("never creates a closed row — the first run is not a backfill of past intros", () => {
    const plan = planIntroTracking(
      [viewRow({ reason: null, auto_state: "cold_lead" }), viewRow({ member_id: "m2", reason: null, auto_state: "converted" })],
      [],
      people,
    );
    expect(plan.creates).toEqual([]);
  });

  it("announces only who converted to a membership", () => {
    const plan = planIntroTracking(
      [
        viewRow({ reason: null, auto_state: "converted" }),
        viewRow({ member_id: "m2", reason: null, auto_state: "bought_other" }),
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
    expect(formatIntroTrackingDigest([], [])).toBeNull();
  });

  it("lists who joined and who converted", () => {
    const { creates } = planIntroTracking([viewRow({ booked_ahead: 1 })], [], people);
    const text = formatIntroTrackingDigest(creates, ["Rita"])!;
    expect(text).toContain("Ana Silva — Pack ended, 2-Class, 2 aulas feita(s), 1 aula marcada(s) (+351 900)");
    expect(text).toContain("Converteram para mensalidade");
    expect(text).toContain("• Rita");
  });
});
