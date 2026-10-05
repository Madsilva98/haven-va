/**
 * "Tracking intro packs" — turns va.v_pulse_intro_pack_tracking (which owns
 * every rule: who belongs on the list, why, and when they leave) into the
 * Notion writes. Nothing here re-derives a date or a threshold; this file
 * only answers "given the view's answer and what's already in Notion, what
 * do we write?" — pure, so it is unit-tested without Notion or the database.
 *
 * Founder's rules (2026-10-02, reasons 2026-10-03):
 * - Someone already on the list is never added again, whatever their Estado
 *   (dedup on Member ID, which a stale import cannot change).
 * - The bot sets Convertido (membership) and Comprou outra coisa (class pack)
 *   over any Estado — the purchase wins, even over Contactado/Perdido.
 * - Cold lead / Idle only replace A contactar / Contactado — never Follow up (the founder is working that
 *   person; they stay on this list, 2026-10-05) and
 *   never a founder's Perdido.
 * - Motivo is a multi-select of the reasons true TODAY — the view's `reasons`,
 *   each tested on its own (a single reason could never show "Underused pack"
 *   on a 10-Day pack: it falls on the same day as "Pack ending", 2026-10-03).
 *   A reason that no longer matches the current state disappears (founder,
 *   2026-10-05, after Jacqueline showed "Pack ending" + "Pack ended"). Only
 *   A contactar / Contactado rows follow today; a closed row — and a Follow up
 *   row — keeps the Motivo it had when it got that Estado, as the record of
 *   why the person was on the list.
 * - A new reason on an A contactar / Contactado row is announced on Telegram.
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

// The Estados the bot keeps live: Motivo follows today, new reasons are announced, and the row can be
// closed as Cold lead / Idle. Follow up (founder, 2026-10-05) is not one of them: the founder is working that
// person — "se está follow-up, não passes para a lista das leads, deixa nos intro packs a converter", and
// "the follow-up should keep the motivo it had before" — so only a purchase or the founder moves it on.
const LIVE_ESTADOS: (IntroTrackingEstado | null)[] = ["A contactar", "Contactado", null];

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
      return LIVE_ESTADOS.includes(current) ? "Cold lead" : null;
    case "idle":
      return LIVE_ESTADOS.includes(current) ? "Idle" : null;
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

export interface NewMotivo {
  pageId: string;
  name: string;
  motivos: IntroTrackingMotivo[]; // only the ones added on this run
}

export interface TrackingPlan {
  creates: TrackingCreate[];
  updates: TrackingUpdate[];
  /** Became Convertido on this run — the only exits announced on Telegram. */
  converted: string[];
  /** Open rows that gained a reason on this run — announced on Telegram. */
  newMotivos: NewMotivo[];
}

function fieldsFor(r: IntroPackTrackingRow, person: Person, motivos: IntroTrackingMotivo[]): IntroTrackingFields {
  return {
    motivos,
    pack: r.pack,
    aulasFeitas: r.visits_in_pack,
    aulasMarcadas: r.booked_ahead,
    compra: r.bought_on,
    inicio: r.first_class_on,
    // "Fim" shows when the pack ends for the person: the 2nd class once both are used, else Kenko's
    // expiry (founder, 2026-10-05: "go with kenko, sometimes we extend the dates manually"). The view's
    // ended_on — the start of the 20-day count — is the class taken for a 1-class 2-Class pack, which
    // read as an already-ended pack (Victoria: Fim 14/09 on a pack valid until 09/10).
    // Nothing before the first class (founder, 2026-10-05): an unstarted pack has no real expiry —
    // Kenko only sets one on activation, so the view's date is a modelled purchase + 10/21 days.
    fim:
      r.visits_in_pack === 0
        ? null
        : r.pack === "2-Class" && r.visits_in_pack >= 2
          ? r.ended_on
          : r.expires_on,
    email: r.email,
    telefone: person.phone,
  };
}

function sameMotivos(a: IntroTrackingMotivo[], b: IntroTrackingMotivo[]): boolean {
  return a.length === b.length && a.every((m) => b.includes(m));
}

function sameFields(row: IntroTrackingRow, f: IntroTrackingFields): boolean {
  return (
    sameMotivos(row.motivos, f.motivos) &&
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

  const plan: TrackingPlan = { creates: [], updates: [], converted: [], newMotivos: [] };
  for (const r of viewRows) {
    const person = people.get(r.member_id) ?? { name: r.email, phone: null };
    const today = (r.reasons ?? []).map((reason) => MOTIVO_BY_REASON[reason]);
    const existing = byMember.get(r.member_id);

    if (!existing) {
      // Only someone who belongs on the list today gets a row — never a
      // closed one, so the first run is not a backfill of every past intro.
      if (today.length > 0 && !r.auto_state) {
        plan.creates.push({ memberId: r.member_id, name: person.name, fields: fieldsFor(r, person, today) });
      }
      continue;
    }

    const estado = nextEstado(existing.estado, r.auto_state);
    const staysOpen = !estado && LIVE_ESTADOS.includes(existing.estado);
    const fields = fieldsFor(r, person, staysOpen ? today : existing.motivos);
    if (!estado && sameFields(existing, fields)) continue;
    const name = existing.nome || person.name;
    plan.updates.push({ pageId: existing.id, name, fields, ...(estado ? { estado } : {}) });
    if (estado === "Convertido") plan.converted.push(name);
    const added = today.filter((m) => !existing.motivos.includes(m));
    if (staysOpen && added.length > 0) plan.newMotivos.push({ pageId: existing.id, name, motivos: added });
  }
  return plan;
}
