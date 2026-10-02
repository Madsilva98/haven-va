/**
 * "Tracking intro packs" — turns va.v_pulse_intro_pack_tracking (which owns
 * every rule: who belongs on the list, why, and when they leave) into the
 * Notion writes. Nothing here re-derives a date or a threshold; this file
 * only answers "given the view's answer and what's already in Notion, what
 * do we write?" — pure, so it is unit-tested without Notion or the database.
 *
 * Founder's rules (2026-10-02):
 * - Someone already on the list is never added again, whatever their Estado
 *   (dedup on Member ID, which a stale import cannot change).
 * - The bot sets Convertido (membership) and Comprou outra coisa (class pack)
 *   over any Estado — the purchase wins, even over Contactado/Perdido.
 * - Cold lead / Idle only replace an open Estado (A contactar / Contactado):
 *   never a founder's Perdido.
 * - Motivo always shows the latest reason; a day with no reason keeps it.
 * - Notas is never part of any write (src/notion.ts).
 */

import type {
  IntroTrackingEstado,
  IntroTrackingFields,
  IntroTrackingMotivo,
  IntroTrackingRow,
} from "../types.js";
import type { IntroPackTrackingRow, IntroTrackingAutoState, IntroTrackingReason } from "./pulse-views.js";

export const MOTIVO_BY_REASON: Record<IntroTrackingReason, IntroTrackingMotivo> = {
  waiting_to_start: "À espera de começar",
  underused: "Underused pack",
  pack_ending: "Pack ending",
  pack_ended: "Pack ended",
};

const OPEN_ESTADOS: (IntroTrackingEstado | null)[] = ["A contactar", "Contactado", null];

/** The Estado the bot moves a row to, or null to leave it as it is. */
export function nextEstado(
  current: IntroTrackingEstado | null,
  autoState: IntroTrackingAutoState | null,
): IntroTrackingEstado | null {
  switch (autoState) {
    case "converted":
      return current === "Convertido" ? null : "Convertido";
    case "bought_other":
      return current === "Convertido" || current === "Comprou outra coisa" ? null : "Comprou outra coisa";
    case "cold_lead":
      return OPEN_ESTADOS.includes(current) ? "Cold lead" : null;
    case "idle":
      return OPEN_ESTADOS.includes(current) ? "Idle" : null;
    default:
      return null;
  }
}

export interface Person {
  name: string;
  phone: string | null;
}

export interface TrackingCreate {
  memberId: string;
  name: string;
  fields: IntroTrackingFields;
}

export interface TrackingUpdate {
  pageId: string;
  name: string;
  fields: IntroTrackingFields;
  estado?: IntroTrackingEstado;
}

export interface TrackingPlan {
  creates: TrackingCreate[];
  updates: TrackingUpdate[];
  /** Became Convertido on this run — the only exits announced on Telegram. */
  converted: string[];
}

function fieldsFor(r: IntroPackTrackingRow, person: Person, motivo?: IntroTrackingMotivo): IntroTrackingFields {
  return {
    motivo,
    pack: r.pack,
    aulasFeitas: r.visits_in_pack,
    aulasMarcadas: r.booked_ahead,
    compra: r.bought_on,
    inicio: r.first_class_on,
    fim: r.ended_on,
    email: r.email,
    telefone: person.phone,
  };
}

function sameFields(row: IntroTrackingRow, f: IntroTrackingFields): boolean {
  return (
    (f.motivo === undefined || row.motivo === f.motivo) &&
    row.aulasFeitas === f.aulasFeitas &&
    row.aulasMarcadas === f.aulasMarcadas &&
    row.inicio === f.inicio &&
    row.fim === f.fim
  );
}

export function planIntroTracking(
  viewRows: IntroPackTrackingRow[],
  notionRows: IntroTrackingRow[],
  people: Map<string, Person>,
): TrackingPlan {
  const byMember = new Map<string, IntroTrackingRow>();
  for (const row of notionRows) if (row.memberId) byMember.set(row.memberId, row);

  const plan: TrackingPlan = { creates: [], updates: [], converted: [] };
  for (const r of viewRows) {
    const person = people.get(r.member_id) ?? { name: r.email, phone: null };
    const motivo = r.reason ? MOTIVO_BY_REASON[r.reason] : undefined;
    const existing = byMember.get(r.member_id);

    if (!existing) {
      // Only someone who belongs on the list today gets a row — never a
      // closed one, so the first run is not a backfill of every past intro.
      if (motivo && !r.auto_state) {
        plan.creates.push({ memberId: r.member_id, name: person.name, fields: fieldsFor(r, person, motivo) });
      }
      continue;
    }

    const fields = fieldsFor(r, person, motivo);
    const estado = nextEstado(existing.estado, r.auto_state);
    if (!estado && sameFields(existing, fields)) continue;
    plan.updates.push({ pageId: existing.id, name: existing.nome || person.name, fields, ...(estado ? { estado } : {}) });
    if (estado === "Convertido") plan.converted.push(existing.nome || person.name);
  }
  return plan;
}
