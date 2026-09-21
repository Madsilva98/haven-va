import { describe, expect, it } from "vitest";

import { formatCasosList, type KnownCase } from "../src/lib/pulse-cases.js";

const row = (over: Partial<KnownCase>): KnownCase => ({
  id: 15,
  status: "open",
  raised_on: "2026-09-21",
  raised_by: "bot",
  source: "session",
  view_name: null,
  subject: "Identity view",
  observed: "o",
  expected: "e",
  rule: null,
  ...over,
});

describe("formatCasosList", () => {
  it("says so when nothing is open", () => {
    expect(formatCasosList([])).toBe("Sem casos abertos 🩵");
  });

  it("lists id, date, who, view and subject, one case per block", () => {
    const text = formatCasosList([
      row({}),
      row({ id: 20, raised_by: "madalena", view_name: "v_pulse_paused_detail", subject: "A Esen não está em pausa" }),
    ]);
    expect(text).toContain("Casos abertos (2)");
    expect(text).toContain("#15 · 21/09/2026 · bot\nIdentity view");
    expect(text).toContain("#20 · 21/09/2026 · madalena · v_pulse_paused_detail\nA Esen não está em pausa");
  });
});
