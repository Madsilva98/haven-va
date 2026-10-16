import { describe, expect, it } from "vitest";

import type { ReferralGuestLeadRow, ReferralGuestState } from "../src/lib/pulse-views.js";
import { planReferralGuests, type Person } from "../src/lib/referral-guest-leads.js";
import { formatReferralGuestDigest } from "../src/messages/referral-guest-leads.js";
import type { ReferralGuestEstado, ReferralGuestRow } from "../src/types.js";

function v(id: string, state: ReferralGuestState, opts: Partial<ReferralGuestLeadRow> = {}): ReferralGuestLeadRow {
  return {
    member_id: id,
    origin: "guest",
    brought_by_member_id: "rita",
    brought_by_name: "Rita C.",
    entered_on: "2026-10-01",
    guest_classes: 1,
    classes_done: 1,
    intro_bought_on: null,
    membership_on: null,
    other_purchase_on: null,
    state,
    data_as_of: "2026-10-15",
    ...opts,
  };
}
const row = (id: string, estado: ReferralGuestEstado | null): ReferralGuestRow => ({ id: `page-${id}`, memberId: id, nome: id, estado });
const PEOPLE = new Map<string, Person>([
  ["ana", { name: "Ana Silva", email: "ana@x.pt", phone: "+351910000001" }],
  ["rita", { name: "Rita Costa", email: "rita@x.pt", phone: null }],
  ["eva", { name: "Eva Matos", email: "eva@x.pt", phone: null }],
]);

describe("planReferralGuests", () => {
  it("a new open person is created A contactar, with who brought them from identity", () => {
    const plan = planReferralGuests([v("ana", "open")], [], PEOPLE);
    expect(plan.creates).toEqual([
      {
        memberId: "ana",
        name: "Ana Silva",
        estado: "A contactar",
        fields: { origem: "Convidado", trazidaPor: "Rita Costa", entrouEm: "2026-10-01", aulasFeitas: 1, email: "ana@x.pt", telefone: "+351910000001" },
      },
    ]);
    expect(plan.toLead.size).toBe(0);
  });

  it("brought_by_name when the member doesn't resolve; Referral origin", () => {
    const plan = planReferralGuests([v("ana", "open", { origin: "referral", brought_by_member_id: null })], [], PEOPLE);
    expect(plan.creates[0]!.fields).toMatchObject({ origem: "Referral", trazidaPor: "Rita C." });
  });

  it("backfill: a new person already cold is created Cold lead and becomes a lead", () => {
    const plan = planReferralGuests([v("ana", "cold")], [], PEOPLE);
    expect(plan.creates[0]!.estado).toBe("Cold lead");
    expect(plan.toLead.has("ana")).toBe(true);
  });

  it("a new person who already bought something is never added", () => {
    expect(planReferralGuests([v("ana", "bought_intro"), v("eva", "converted")], [], PEOPLE).creates).toEqual([]);
  });

  it("a purchase wins over any Estado, Perdido and Follow up included", () => {
    const plan = planReferralGuests(
      [v("ana", "bought_intro"), v("eva", "converted"), v("rita", "bought_other")],
      [row("ana", "Perdido"), row("eva", "Follow up"), row("rita", "Cold lead")],
      PEOPLE,
    );
    expect(plan.updates.map((u) => [u.memberId, u.estado])).toEqual([
      ["ana", "Comprou intro pack"],
      ["eva", "Convertido"],
      ["rita", "Comprou outra coisa"],
    ]);
  });

  it("cold only over A contactar / Contactado, and only those become leads", () => {
    const plan = planReferralGuests(
      [v("ana", "cold"), v("eva", "cold"), v("rita", "cold"), v("x", "cold")],
      [row("ana", "A contactar"), row("eva", "Contactado"), row("rita", "Follow up"), row("x", "Perdido")],
      PEOPLE,
    );
    expect(plan.updates.filter((u) => u.estado).map((u) => u.memberId)).toEqual(["ana", "eva"]);
    expect([...plan.toLead].sort()).toEqual(["ana", "eva"]);
    // Follow up still refreshed, Perdido (closed, unchanged) left alone.
    expect(plan.updates.map((u) => u.memberId)).toEqual(["ana", "eva", "rita"]);
  });

  it("an already Cold lead row stays as it is: no second lead", () => {
    const plan = planReferralGuests([v("ana", "cold")], [row("ana", "Cold lead")], PEOPLE);
    expect(plan.updates).toEqual([]);
    expect(plan.toLead.size).toBe(0);
  });

  it("an open row keeps the founders' Estado and gets its fields refreshed", () => {
    const plan = planReferralGuests([v("ana", "open", { classes_done: 2 })], [row("ana", "Contactado")], PEOPLE);
    expect(plan.updates).toEqual([expect.objectContaining({ memberId: "ana", fields: expect.objectContaining({ aulasFeitas: 2 }) })]);
    expect(plan.updates[0]!.estado).toBeUndefined();
  });
});

describe("formatReferralGuestDigest", () => {
  it("lists only the new A contactar rows", () => {
    const plan = planReferralGuests([v("ana", "open"), v("eva", "cold", { origin: "referral", brought_by_member_id: null, brought_by_name: null })], [], PEOPLE);
    expect(formatReferralGuestDigest(plan.creates)).toBe(
      "Referidos e convidados · novos na lista (ainda sem intro pack)\n· Ana Silva: Convidado via Rita Costa · +351910000001",
    );
  });

  it("null when nobody new", () => {
    expect(formatReferralGuestDigest([])).toBeNull();
  });

  it("caps at 10 lines", () => {
    const many = Array.from({ length: 12 }, (_, i) => v(`p${String(i).padStart(2, "0")}`, "open"));
    const text = formatReferralGuestDigest(planReferralGuests(many, [], new Map()).creates)!;
    expect(text.split("\n")).toHaveLength(12);
    expect(text).toContain("+2 na lista do Notion");
  });
});
