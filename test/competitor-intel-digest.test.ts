import { describe, expect, it } from "vitest";

import { formatCompetitorIntelDigest } from "../src/messages/competitor-intel.js";
import type { CompetitorIntelRunSummary } from "../src/types.js";

function summary(overrides: Partial<CompetitorIntelRunSummary>): CompetitorIntelRunSummary {
  return {
    messagesSeen: 0,
    messagesProcessed: 0,
    findingsWritten: 0,
    errors: 0,
    byMessage: [],
    ...overrides,
  };
}

describe("formatCompetitorIntelDigest", () => {
  it("says nothing new when there are no findings at all", () => {
    const out = formatCompetitorIntelDigest({ summary: summary({}) });
    expect(out).toContain("sem lançamentos ou promoções novas");
    expect(out).not.toContain("achado(s) adicional");
  });

  it("surfaces Produto/Serviço and Promoção/Campanha findings, grouped by sender", () => {
    const out = formatCompetitorIntelDigest({
      summary: summary({
        byMessage: [
          {
            fromName: "Swet Studios",
            fromEmail: "info@swetstudios.com",
            subject: "New offer",
            findings: [{ tipo: "Promoção/Campanha", resumo: "3 aulas por 55 euros." }],
          },
        ],
      }),
    });
    expect(out).toContain("Swet Studios");
    expect(out).toContain("3 aulas por 55 euros");
    expect(out).not.toContain("sem lançamentos");
  });

  it("counts Evento/Posicionamento findings instead of listing them", () => {
    const out = formatCompetitorIntelDigest({
      summary: summary({
        byMessage: [
          {
            fromName: "KORE Pilates & Cafe",
            fromEmail: "anneke@korestudios.eu",
            subject: "Update",
            findings: [
              { tipo: "Evento", resumo: "Barre event on the rooftop." },
              { tipo: "Posicionamento/Mensagem", resumo: "New cancellation policy." },
            ],
          },
        ],
      }),
    });
    expect(out).toContain("sem lançamentos ou promoções novas");
    expect(out).toContain("2 achado");
    expect(out).not.toContain("Barre event");
    expect(out).not.toContain("cancellation policy");
  });

  it("mixes highlighted and counted findings from the same message", () => {
    const out = formatCompetitorIntelDigest({
      summary: summary({
        byMessage: [
          {
            fromName: "Core Collective",
            fromEmail: "studio@thecorecollective.eu",
            subject: "News",
            findings: [
              { tipo: "Produto/Serviço", resumo: "New recovery room opening." },
              { tipo: "Evento", resumo: "Pop-up class in Cascais." },
            ],
          },
        ],
      }),
    });
    expect(out).toContain("New recovery room opening");
    expect(out).toContain("1 achado");
    expect(out).not.toContain("Pop-up class");
  });

  it("shows the error line when errors > 0", () => {
    const out = formatCompetitorIntelDigest({ summary: summary({ errors: 2 }) });
    expect(out).toContain("2 email");
    expect(out).toContain("com erro");
  });
});
