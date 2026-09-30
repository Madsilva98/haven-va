import { afterEach, describe, expect, it, vi } from "vitest";

const isStudioDbAvailable = vi.fn().mockReturnValue(true);
vi.mock("../src/lib/studio-db.js", () => ({
  isStudioDbAvailable: () => isStudioDbAvailable(),
}));

const fetchDataAsOf = vi.fn();
const fetchChurnRiskSignals = vi.fn();
const fetchMemberIdentity = vi.fn();
vi.mock("../src/lib/pulse-views.js", () => ({
  fetchDataAsOf: (...args: unknown[]) => fetchDataAsOf(...args),
  fetchChurnRiskSignals: (...args: unknown[]) => fetchChurnRiskSignals(...args),
  fetchMemberIdentity: (...args: unknown[]) => fetchMemberIdentity(...args),
}));

import { fetchChurnFlags, renderChurnSignals } from "../src/lib/churn-signals.js";
import type { ChurnRiskSignalRow } from "../src/lib/pulse-views.js";

function row(over: Partial<ChurnRiskSignalRow> = {}): ChurnRiskSignalRow {
  return {
    member_id: "m1",
    current_tier: "4x",
    current_plan: "Premium",
    has_no_booking: false,
    no_booking_gap_days: null,
    no_booking_last_date: null,
    no_booking_stretch_start: null,
    no_booking_resumed_from_pause: null,
    has_failed_payment: false,
    failed_payment_date: null,
    has_low_utilization: false,
    low_util_avg_pct: null,
    low_util_months: null,
    ...over,
  };
}

describe("renderChurnSignals — pure rendering of the view's facts into pt-PT text", () => {
  it("returns no signals for a row with nothing flagged", () => {
    expect(renderChurnSignals(row())).toEqual([]);
  });

  it("Sem reservas 14+ dias — with a last in-stretch booking", () => {
    const signals = renderChurnSignals(
      row({ has_no_booking: true, no_booking_gap_days: 24, no_booking_last_date: "2026-08-28" }),
    );
    expect(signals).toEqual([
      { type: "Sem reservas 14+ dias", detail: "24 dias sem reservar (última aula marcada: 28/08/2026)" },
    ]);
  });

  it("Sem reservas 14+ dias — resumed from a pause, no booking since", () => {
    const signals = renderChurnSignals(
      row({
        has_no_booking: true,
        no_booking_gap_days: 3,
        no_booking_last_date: null,
        no_booking_resumed_from_pause: true,
        no_booking_stretch_start: "2026-09-26",
      }),
    );
    expect(signals).toEqual([
      { type: "Sem reservas 14+ dias", detail: "3 dias sem reservar desde a pausa (de volta até 26/09/2026)" },
    ]);
  });

  it("Sem reservas 14+ dias — never booked since joining, no pause involved", () => {
    const signals = renderChurnSignals(
      row({
        has_no_booking: true,
        no_booking_gap_days: 47,
        no_booking_last_date: null,
        no_booking_resumed_from_pause: false,
        no_booking_stretch_start: "2025-12-26",
      }),
    );
    expect(signals).toEqual([{ type: "Sem reservas 14+ dias", detail: "47 dias sem nenhuma reserva desde a inscrição" }]);
  });

  it("Pagamento falhado", () => {
    const signals = renderChurnSignals(row({ has_failed_payment: true, failed_payment_date: "2026-08-23" }));
    expect(signals).toEqual([{ type: "Pagamento falhado", detail: "pagamento falhado a 23/08/2026" }]);
  });

  it("does not render Pagamento falhado when has_failed_payment is false, even with a stray date", () => {
    // Suppression (paid-since / upcoming-booking) now happens entirely in
    // va.v_pulse_churn_risk_signals — this just confirms the render layer
    // trusts has_failed_payment as the gate, not the presence of a date.
    const signals = renderChurnSignals(row({ has_failed_payment: false, failed_payment_date: "2026-08-23" }));
    expect(signals).toEqual([]);
  });

  it("Baixa utilização", () => {
    const signals = renderChurnSignals(
      row({
        has_low_utilization: true,
        low_util_avg_pct: 8.3,
        low_util_months: [
          { month: "2026-06-01", pct: 5 },
          { month: "2026-07-01", pct: 10 },
          { month: "2026-08-01", pct: 10 },
        ],
      }),
    );
    expect(signals).toEqual([
      { type: "Baixa utilização", detail: "8% de utilização média nos últimos 3 meses (jun.: 5%, jul.: 10%, ago.: 10%)" },
    ]);
  });

  it("combines multiple signals for the same row", () => {
    const signals = renderChurnSignals(
      row({
        has_no_booking: true,
        no_booking_gap_days: 20,
        no_booking_last_date: "2026-09-05",
        has_low_utilization: true,
        low_util_avg_pct: 12,
        low_util_months: [
          { month: "2026-06-01", pct: 10 },
          { month: "2026-07-01", pct: 12 },
          { month: "2026-08-01", pct: 14 },
        ],
      }),
    );
    expect(signals.map((s) => s.type)).toEqual(["Sem reservas 14+ dias", "Baixa utilização"]);
  });
});

describe("fetchChurnFlags", () => {
  afterEach(() => {
    isStudioDbAvailable.mockReturnValue(true);
    fetchDataAsOf.mockReset();
    fetchChurnRiskSignals.mockReset();
    fetchMemberIdentity.mockReset();
  });

  it("no-ops when the studio connection isn't configured", async () => {
    isStudioDbAvailable.mockReturnValue(false);
    const { flags, activeEmails, asOf } = await fetchChurnFlags();
    expect(flags).toEqual([]);
    expect(activeEmails.size).toBe(0);
    expect(asOf).toBeNull();
    expect(fetchChurnRiskSignals).not.toHaveBeenCalled();
  });

  it("joins identity for name/email/phone, renders signals, and reports every active email — skipping a member missing from v_pulse_member_identity entirely", async () => {
    fetchDataAsOf.mockResolvedValue("2026-09-29");
    fetchChurnRiskSignals.mockResolvedValue([
      row({ member_id: "known", has_no_booking: true, no_booking_gap_days: 20, no_booking_stretch_start: "2026-09-01" }),
      row({ member_id: "quiet" }), // active, no current signal
      row({ member_id: "unknown" }), // no identity row — dropped, not even counted active
    ]);
    fetchMemberIdentity.mockResolvedValue([
      { member_id: "known", contact_name: "Ana", contact_email: "ana@x.com", contact_phone: "+351", date_of_birth: null },
      { member_id: "quiet", contact_name: "Beatriz", contact_email: "beatriz@x.com", contact_phone: null, date_of_birth: null },
    ]);

    const { flags, activeEmails, asOf } = await fetchChurnFlags();

    expect(asOf).toBe("2026-09-29");
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({ email: "ana@x.com", name: "Ana", plano: "4x Monthly | Premium", telefone: "+351" });
    expect(activeEmails).toEqual(new Set(["ana@x.com", "beatriz@x.com"]));
  });
});
