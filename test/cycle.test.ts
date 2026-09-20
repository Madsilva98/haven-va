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

  it("folds completed and overdue tasks into the owning founder's block instead of separate sections", () => {
    const out = formatFridayBalance({
      weekLabel: "Semana 38",
      prioritiesByFounder: emptyPrioritiesByFounder(),
      completed: [task("a", "Feito", { owner: "Mafalda" })],
      overdue: [task("c", "To do", { owner: "Beatriz" })],
      focus: [],
    });

    expect(out).not.toContain("feito esta semana");
    expect(out).not.toContain("*atrasadas");
    expect(out).toContain("*Mafalda*");
    expect(out).toContain("🟢 a");
    expect(out).toContain("*Beatriz*");
    expect(out).toContain("🔴 c ⏰");
  });

  it("dedupes a task that's both a weekly priority and overdue, keeping the overdue marker", () => {
    const prioritiesByFounder = emptyPrioritiesByFounder();
    prioritiesByFounder.Madalena = [task("relatório", "To do")];

    const out = formatFridayBalance({
      weekLabel: "Semana 38",
      prioritiesByFounder,
      completed: [],
      overdue: [task("relatório", "To do")],
      focus: [],
    });

    const occurrences = out.split("relatório").length - 1;
    expect(occurrences).toBe(1);
    expect(out).toContain("🔴 relatório ⏰");
  });

  it("drops unassigned-owner completed/overdue tasks, which have no founder block to land in", () => {
    const out = formatFridayBalance({
      weekLabel: "Semana 38",
      prioritiesByFounder: emptyPrioritiesByFounder(),
      completed: [task("misc", "Feito", { owner: "Unassigned" })],
      overdue: [],
      focus: [],
    });

    expect(out).not.toContain("misc");
  });
});
