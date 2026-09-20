import { describe, expect, it } from "vitest";

import { formatFridayBalance } from "../src/messages/cycle.js";
import type { FounderName, OpenTask, Status } from "../src/types.js";

function task(title: string, status: Status, overrides: Partial<OpenTask> = {}): OpenTask {
  return {
    id: title,
    title,
    owner: "Madalena",
    area: "Operações",
    priority: null,
    deadline: null,
    status,
    ...overrides,
  };
}

function emptyPrioritiesByFounder(): Record<FounderName, OpenTask[]> {
  return { Madalena: [], Mafalda: [], Beatriz: [] };
}

describe("formatFridayBalance", () => {
  it("groups priorities per founder with color-coded status markers", () => {
    const prioritiesByFounder = emptyPrioritiesByFounder();
    prioritiesByFounder.Madalena = [
      task("fechar deal X", "Feito"),
      task("rever contrato", "Em curso"),
      task("preparar reunião", "To do"),
    ];

    const out = formatFridayBalance({
      weekLabel: "Semana 38",
      prioritiesByFounder,
      completed: [],
      overdue: [],
      focus: [],
    });

    expect(out).toContain("*Madalena*");
    expect(out).toContain("🟢 fechar deal X");
    expect(out).toContain("🟡 rever contrato");
    expect(out).toContain("🔴 preparar reunião");
  });

  it("shows each founder's own foco next to their priorities", () => {
    const out = formatFridayBalance({
      weekLabel: "Semana 38",
      prioritiesByFounder: emptyPrioritiesByFounder(),
      completed: [],
      overdue: [],
      focus: [
        { founder: "Mafalda", weekNumber: 38, focoOperacional: "fechar parcerias" },
        { founder: "Beatriz", weekNumber: 37, focoOperacional: "onboarding novo staff" },
      ],
    });

    expect(out).toContain("*Mafalda*");
    expect(out).toContain("fechar parcerias");
    expect(out).toContain("*Beatriz*");
    expect(out).toContain("onboarding novo staff");
  });

  it("omits a founder entirely when they have neither focus nor priorities", () => {
    const prioritiesByFounder = emptyPrioritiesByFounder();
    prioritiesByFounder.Madalena = [task("algo", "To do")];

    const out = formatFridayBalance({
      weekLabel: "Semana 38",
      prioritiesByFounder,
      completed: [],
      overdue: [],
      focus: [],
    });

    expect(out).toContain("*Madalena*");
    expect(out).not.toContain("*Mafalda*");
    expect(out).not.toContain("*Beatriz*");
  });

  it("still reports completed and overdue counts", () => {
    const out = formatFridayBalance({
      weekLabel: "Semana 38",
      prioritiesByFounder: emptyPrioritiesByFounder(),
      completed: [task("a", "Feito"), task("b", "Feito")],
      overdue: [task("c", "To do")],
      focus: [],
    });

    expect(out).toContain("feito esta semana \\(2\\)");
    expect(out).toContain("atrasadas \\(1\\)");
  });
});
