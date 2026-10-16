/**
 * "Referidos e convidados" (Madalena, 2026-10-16): maps va.v_pulse_referral_guest_leads onto the
 * Notion list. Pure. Every rule — who is in, the 60-day backfill, "never paid before", cold at 30
 * days — is the view's `state`; this only decides the Notion writes:
 *
 * - New person, `open` → created "A contactar" and announced. New person already `cold` (the
 *   backfill) → created "Cold lead" and passed to "Leads a contactar". A new person who already
 *   bought something is never added.
 * - A purchase wins over any Estado: "Comprou intro pack" (they then show up in Tracking intro
 *   packs on their own), "Convertido" (membership), "Comprou outra coisa".
 * - `cold` moves only "A contactar" / "Contactado" to "Cold lead" and creates the lead — never a
 *   founder's "Perdido" (never a lead) or "Follow up" (being worked).
 */

import type { ReferralGuestLeadRow, ReferralGuestState } from "./pulse-views.js";
import type { ReferralGuestEstado, ReferralGuestFields, ReferralGuestOrigem, ReferralGuestRow } from "../types.js";

export interface Person {
  name: string | null;
  email: string | null;
  phone: string | null;
}

export interface ReferralGuestCreate {
  memberId: string;
  name: string;
  fields: ReferralGuestFields;
  estado: ReferralGuestEstado;
}
export interface ReferralGuestUpdate {
  pageId: string;
  memberId: string;
  name: string;
  fields: ReferralGuestFields;
  /** Set only when the Estado changes. */
  estado?: ReferralGuestEstado;
}
export interface ReferralGuestPlan {
  creates: ReferralGuestCreate[];
  updates: ReferralGuestUpdate[];
  /** memberIds whose row goes (or went in this run) to Cold lead: a lead in "Leads a contactar". */
  toLead: Set<string>;
}

const PURCHASE: Partial<Record<ReferralGuestState, ReferralGuestEstado>> = {
  bought_intro: "Comprou intro pack",
  converted: "Convertido",
  bought_other: "Comprou outra coisa",
};
const COLD_OVER: (ReferralGuestEstado | null)[] = ["A contactar", "Contactado", null];

export function origemOf(origin: ReferralGuestLeadRow["origin"]): ReferralGuestOrigem {
  return origin === "referral" ? "Referral" : "Convidado";
}

export function planReferralGuests(
  view: ReferralGuestLeadRow[],
  notion: ReferralGuestRow[],
  people: Map<string, Person>,
): ReferralGuestPlan {
  const existing = new Map(notion.filter((r) => r.memberId).map((r) => [r.memberId, r]));
  const plan: ReferralGuestPlan = { creates: [], updates: [], toLead: new Set() };

  for (const v of view) {
    const person = people.get(v.member_id);
    const name = person?.name ?? `sem nome (${v.member_id.slice(0, 8)})`;
    const broughtBy =
      (v.brought_by_member_id ? people.get(v.brought_by_member_id)?.name : null) ?? v.brought_by_name ?? null;
    const fields: ReferralGuestFields = {
      origem: origemOf(v.origin),
      trazidaPor: broughtBy,
      entrouEm: v.entered_on,
      aulasFeitas: v.classes_done,
      email: person?.email ?? null,
      telefone: person?.phone ?? null,
    };
    const row = existing.get(v.member_id);

    if (!row) {
      if (v.state === "open") plan.creates.push({ memberId: v.member_id, name, fields, estado: "A contactar" });
      else if (v.state === "cold") {
        plan.creates.push({ memberId: v.member_id, name, fields, estado: "Cold lead" });
        plan.toLead.add(v.member_id);
      }
      continue;
    }

    let estado: ReferralGuestEstado | undefined;
    const bought = PURCHASE[v.state];
    if (bought) estado = bought;
    else if (v.state === "cold" && COLD_OVER.includes(row.estado)) {
      estado = "Cold lead";
      plan.toLead.add(v.member_id);
    }
    if (estado === row.estado) estado = undefined;
    // A closed row that isn't changing needs no refresh.
    const closed = row.estado !== null && !["A contactar", "Contactado", "Follow up"].includes(row.estado);
    if (closed && !estado) continue;
    plan.updates.push({ pageId: row.id, memberId: v.member_id, name, fields, ...(estado ? { estado } : {}) });
  }
  return plan;
}
