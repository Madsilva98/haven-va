/**
 * Churn-risk signal rendering for src/crons/churn-risk.ts.
 *
 * As of 2026-09-30, the 3 empirically-validated signals (roster, pause
 * handling, the day/month thresholds, the failed-payment suppression) are
 * computed entirely in `va.v_pulse_churn_risk_signals`
 * (scripts/studio-db-views-2026-09-30.sql) — founder's call: "quero que
 * uses views e que não estejas sempre computing do 0". This file only
 * turns that view's facts into the pt-PT message text (day counts, month
 * labels, percentages), which stays here deliberately — it's the fiddly,
 * easy-to-typo part, and it's unit-tested.
 *
 * See the view's own SQL comments for the exact signal definitions (the
 * Sofia Barata pause case, the Maria Murteira/Darina Sinegubova
 * suppression cases, the Raquel Saraiva/Francesca Buoncristiani
 * utilization exclusions, etc.) — this file no longer re-derives any of
 * that, so those stories live at the SQL layer now, not here.
 */

import type { ChurnSignalType } from "../types.js";
import { log } from "./log.js";
import {
  fetchChurnRiskSignals,
  fetchDataAsOf,
  fetchMemberIdentity,
  type ChurnRiskSignalRow,
  type MemberIdentityRow,
} from "./pulse-views.js";
import { isStudioDbAvailable } from "./studio-db.js";

export interface ChurnFlag {
  email: string;
  name: string;
  plano: string;
  telefone: string | null;
  signals: { type: ChurnSignalType; detail: string }[];
}

function formatDatePt(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split("-");
  return `${d}/${m}/${y}`;
}

function monthLabelPt(monthIso: string): string {
  return new Date(`${monthIso.slice(0, 10)}T12:00:00Z`).toLocaleDateString("pt-PT", {
    timeZone: "Europe/Lisbon",
    month: "short",
  });
}

/**
 * Pure — no I/O. Renders one view row's facts into the pt-PT signal list,
 * or null if the row has none (still active, nothing currently wrong).
 */
export function renderChurnSignals(row: ChurnRiskSignalRow): ChurnFlag["signals"] {
  const signals: ChurnFlag["signals"] = [];

  if (row.has_no_booking) {
    const gapDays = Math.round(row.no_booking_gap_days ?? 0);
    const detail = row.no_booking_last_date
      ? `${gapDays} dias sem reservar (última aula marcada: ${formatDatePt(row.no_booking_last_date)})`
      : row.no_booking_resumed_from_pause
        ? `${gapDays} dias sem reservar desde a pausa (de volta até ${formatDatePt(row.no_booking_stretch_start!)})`
        : `${gapDays} dias sem nenhuma reserva desde a inscrição`;
    signals.push({ type: "Sem reservas 14+ dias", detail });
  }

  if (row.has_failed_payment && row.failed_payment_date) {
    signals.push({
      type: "Pagamento falhado",
      detail: `pagamento falhado a ${formatDatePt(row.failed_payment_date)}`,
    });
  }

  if (row.has_low_utilization && row.low_util_months) {
    const parts = row.low_util_months.map((m) => `${monthLabelPt(m.month)}: ${Math.round(m.pct)}%`);
    signals.push({
      type: "Baixa utilização",
      detail: `${Math.round(row.low_util_avg_pct ?? 0)}% de utilização média nos últimos 3 meses (${parts.join(", ")})`,
    });
  }

  return signals;
}

/**
 * Reads the view and renders flags. Also returns every email currently a
 * paying member (flagged or not) — src/crons/churn-risk.ts uses this to
 * tell "still active, just no current signal" apart from "no longer a
 * member" — and the data date the digest should quote.
 *
 * Returns empty (and logs a warn) if the studio connection isn't
 * configured — same graceful no-op as src/lib/birthdays.ts.
 */
export async function fetchChurnFlags(): Promise<{
  flags: ChurnFlag[];
  activeEmails: Set<string>;
  asOf: string | null;
}> {
  if (!isStudioDbAvailable()) {
    log.warn("churn_signals.fetch_skipped", { reason: "studio_db_not_configured" });
    return { flags: [], activeEmails: new Set(), asOf: null };
  }

  const [asOf, signalRows, identity] = await Promise.all([
    fetchDataAsOf(),
    fetchChurnRiskSignals(),
    fetchMemberIdentity(),
  ]);
  if (!asOf) {
    log.warn("churn_signals.no_data_as_of");
    return { flags: [], activeEmails: new Set(), asOf: null };
  }

  const identityByMember = new Map<string, MemberIdentityRow>(identity.map((r) => [r.member_id, r]));
  const activeEmails = new Set<string>();
  const flags: ChurnFlag[] = [];

  for (const row of signalRows) {
    const id = identityByMember.get(row.member_id);
    if (!id?.contact_email) {
      log.warn("churn_signals.member_without_identity", { memberId: row.member_id });
      continue;
    }
    const email = id.contact_email.toLowerCase();
    activeEmails.add(email);

    const signals = renderChurnSignals(row);
    if (signals.length === 0) continue;

    flags.push({
      email,
      name: id.contact_name?.trim() || id.contact_email,
      plano: `${row.current_tier ?? "?"} Monthly | ${row.current_plan ?? "?"}`,
      telefone: id.contact_phone ?? null,
      signals,
    });
  }

  log.debug("churn_signals.computed", { asOf, members: signalRows.length, flagged: flags.length });
  return { flags, activeEmails, asOf };
}
