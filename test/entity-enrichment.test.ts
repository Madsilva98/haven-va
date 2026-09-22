import { afterEach, describe, expect, it, vi } from "vitest";

const enrichPartnerFromTranscript = vi.fn();
const enrichInfluencerFromTranscript = vi.fn();
const enrichSupplierFromTranscript = vi.fn();
vi.mock("../src/lib/lead-classifier.js", () => ({
  enrichPartnerFromTranscript: (...args: unknown[]) => enrichPartnerFromTranscript(...args),
  enrichInfluencerFromTranscript: (...args: unknown[]) => enrichInfluencerFromTranscript(...args),
  enrichSupplierFromTranscript: (...args: unknown[]) => enrichSupplierFromTranscript(...args),
}));

const findBestNameMatch = vi.fn();
const findVisitHistory = vi.fn();
vi.mock("../src/lib/leads.js", () => ({
  findBestNameMatch: (...args: unknown[]) => findBestNameMatch(...args),
  findVisitHistory: (...args: unknown[]) => findVisitHistory(...args),
}));

const replacePageSection = vi.fn().mockResolvedValue(undefined);
const appendToPageSection = vi.fn().mockResolvedValue(undefined);
const updateInfluencerFields = vi.fn().mockResolvedValue(undefined);
vi.mock("../src/notion.js", () => ({
  replacePageSection: (...args: unknown[]) => replacePageSection(...args),
  appendToPageSection: (...args: unknown[]) => appendToPageSection(...args),
  updateInfluencerFields: (...args: unknown[]) => updateInfluencerFields(...args),
}));

import {
  applyInfluencerCurrentState,
  applyPartnerCurrentState,
  applySupplierCurrentState,
  dated,
  enrichInfluencerPageFromText,
  enrichPartnerPageFromText,
  enrichSupplierPageFromText,
  formatDatePt,
  formatKenkoLine,
} from "../src/lib/entity-enrichment.js";

describe("entity-enrichment", () => {
  afterEach(() => {
    enrichPartnerFromTranscript.mockReset();
    enrichInfluencerFromTranscript.mockReset();
    enrichSupplierFromTranscript.mockReset();
    findBestNameMatch.mockReset();
    findVisitHistory.mockReset();
    replacePageSection.mockReset().mockResolvedValue(undefined);
    appendToPageSection.mockReset().mockResolvedValue(undefined);
    updateInfluencerFields.mockReset().mockResolvedValue(undefined);
  });

  describe("formatDatePt / dated", () => {
    it("formats an ISO date as dd/mm/yyyy", () => {
      expect(formatDatePt("2026-09-21T10:00:00Z")).toBe("21/09/2026");
    });

    it("prefixes text with today's date in brackets", () => {
      const result = dated("algo aconteceu");
      expect(result).toMatch(/^\[\d{2}\/\d{2}\/\d{4}\] algo aconteceu$/);
    });
  });

  describe("formatKenkoLine", () => {
    it("reports visit history when a volunteered email has real visits", () => {
      findVisitHistory.mockReturnValue({
        firstVisit: "2026-01-01T00:00:00Z",
        lastVisit: "2026-02-01T00:00:00Z",
        visitCount: 3,
      });
      const line = formatKenkoLine("ines@x.com", "Inês", [], new Map());
      expect(line).toContain("já visitou o estúdio");
      expect(line).toContain("3 visitas");
    });

    it("reports no history for a volunteered email with nothing on file", () => {
      findVisitHistory.mockReturnValue(null);
      const line = formatKenkoLine("ines@x.com", "Inês", [], new Map());
      expect(line).toBe("Kenko: sem histórico de visitas para este email.");
    });

    it("falls back to a fuzzy name match when no email was volunteered", () => {
      findBestNameMatch.mockReturnValue({ name: "Inês Silva", email: null, score: 0.8 });
      const line = formatKenkoLine(null, "Ines Silva", [], new Map());
      expect(line).toContain("possível correspondência");
      expect(line).toContain("Inês Silva");
    });

    it("reports no correspondence when neither email nor fuzzy match is available", () => {
      findBestNameMatch.mockReturnValue(null);
      const line = formatKenkoLine(null, "Desconhecida", [], new Map());
      expect(line).toBe("Kenko: sem correspondência.");
    });
  });

  describe("applyPartnerCurrentState", () => {
    it("replaces Sobre and Deal sections from the enrichment result", async () => {
      enrichPartnerFromTranscript.mockResolvedValue({
        sobre: "Estúdio de yoga em Cascais",
        deal: "Workshop conjunto em outubro",
        log: "Contacto inicial recebido.",
      });
      const result = await applyPartnerCurrentState("page-1", "texto");
      expect(replacePageSection).toHaveBeenCalledWith("page-1", "Estúdio de yoga em Cascais", "Sobre o parceiro");
      expect(replacePageSection).toHaveBeenCalledWith("page-1", "Workshop conjunto em outubro", "Deal e proposta");
      expect(result?.log).toBe("Contacto inicial recebido.");
    });

    it("skips replacing a section whose field is null", async () => {
      enrichPartnerFromTranscript.mockResolvedValue({ sobre: null, deal: null, log: "resumo" });
      await applyPartnerCurrentState("page-1", "texto");
      expect(replacePageSection).not.toHaveBeenCalled();
    });

    it("returns null when the classifier call fails", async () => {
      enrichPartnerFromTranscript.mockResolvedValue(null);
      const result = await applyPartnerCurrentState("page-1", "texto");
      expect(result).toBeNull();
      expect(replacePageSection).not.toHaveBeenCalled();
    });
  });

  describe("applyInfluencerCurrentState", () => {
    it("writes structured fields including a volunteered email", async () => {
      enrichInfluencerFromTranscript.mockResolvedValue({
        sobre: "Cria conteúdo de lifestyle",
        nicho: "Lifestyle",
        tipoColaboracao: ["Post patrocinado"],
        status: "Em conversa",
        proximoPasso: "Marcar visita",
        log: "resumo",
      });
      await applyInfluencerCurrentState("page-2", "texto", "Marta", {
        volunteeredEmail: "marta@x.com",
        ultimoContacto: "2026-09-20T00:00:00Z",
      });
      expect(updateInfluencerFields).toHaveBeenCalledWith("page-2", {
        status: "Em conversa",
        tipoColaboracao: ["Post patrocinado"],
        nicho: "Lifestyle",
        proximoPasso: "Marcar visita",
        ultimoContacto: "2026-09-20T00:00:00Z",
        email: "marta@x.com",
      });
    });

    it("skips the Kenko cross-reference when customers/activity aren't supplied", async () => {
      enrichInfluencerFromTranscript.mockResolvedValue({
        sobre: "Sobre a Marta",
        nicho: null,
        tipoColaboracao: [],
        status: null,
        proximoPasso: null,
        log: "resumo",
      });
      await applyInfluencerCurrentState("page-2", "texto", "Marta");
      expect(replacePageSection).toHaveBeenCalledWith("page-2", "Sobre a Marta", "Perfil e stats");
      expect(findVisitHistory).not.toHaveBeenCalled();
      expect(findBestNameMatch).not.toHaveBeenCalled();
    });
  });

  describe("applySupplierCurrentState", () => {
    it("replaces Sobre and Termos sections from the enrichment result", async () => {
      enrichSupplierFromTranscript.mockResolvedValue({
        sobre: "Vende equipamento de Pilates",
        termos: "Desconto de 10% em compras acima de 500€",
        log: "Contacto inicial recebido.",
      });
      const result = await applySupplierCurrentState("page-3", "texto");
      expect(replacePageSection).toHaveBeenCalledWith("page-3", "Vende equipamento de Pilates", "Sobre o fornecedor");
      expect(replacePageSection).toHaveBeenCalledWith("page-3", "Desconto de 10% em compras acima de 500€", "Termos e condições");
      expect(result?.log).toBe("Contacto inicial recebido.");
    });

    it("skips replacing a section whose field is null", async () => {
      enrichSupplierFromTranscript.mockResolvedValue({ sobre: null, termos: null, log: "resumo" });
      await applySupplierCurrentState("page-3", "texto");
      expect(replacePageSection).not.toHaveBeenCalled();
    });

    it("returns null when the classifier call fails", async () => {
      enrichSupplierFromTranscript.mockResolvedValue(null);
      const result = await applySupplierCurrentState("page-3", "texto");
      expect(result).toBeNull();
      expect(replacePageSection).not.toHaveBeenCalled();
    });
  });

  describe("enrichPartnerPageFromText", () => {
    it("appends a dated Log entry when the enrichment produced one", async () => {
      enrichPartnerFromTranscript.mockResolvedValue({ sobre: null, deal: null, log: "Primeiro contacto." });
      await enrichPartnerPageFromText("page-1", "texto");
      expect(appendToPageSection).toHaveBeenCalledTimes(1);
      const [pageId, content, section] = appendToPageSection.mock.calls[0]!;
      expect(pageId).toBe("page-1");
      expect(content).toMatch(/^\[\d{2}\/\d{2}\/\d{4}\] Primeiro contacto\.$/);
      expect(section).toBe("Log");
    });

    it("never throws when the underlying classifier call rejects", async () => {
      enrichPartnerFromTranscript.mockRejectedValue(new Error("API down"));
      await expect(enrichPartnerPageFromText("page-1", "texto")).resolves.toBeUndefined();
      expect(appendToPageSection).not.toHaveBeenCalled();
    });
  });

  describe("enrichInfluencerPageFromText", () => {
    it("appends a dated Relação e histórico entry when the enrichment produced one", async () => {
      enrichInfluencerFromTranscript.mockResolvedValue({
        sobre: null,
        nicho: null,
        tipoColaboracao: [],
        status: null,
        proximoPasso: null,
        log: "Primeira troca de mensagens.",
      });
      await enrichInfluencerPageFromText("page-2", "texto", "Marta");
      expect(appendToPageSection).toHaveBeenCalledWith("page-2", expect.stringContaining("Primeira troca de mensagens."), "Relação e histórico");
    });

    it("never throws when the underlying classifier call rejects", async () => {
      enrichInfluencerFromTranscript.mockRejectedValue(new Error("API down"));
      await expect(enrichInfluencerPageFromText("page-2", "texto", "Marta")).resolves.toBeUndefined();
      expect(appendToPageSection).not.toHaveBeenCalled();
    });
  });

  describe("enrichSupplierPageFromText", () => {
    it("appends a dated Log entry when the enrichment produced one", async () => {
      enrichSupplierFromTranscript.mockResolvedValue({ sobre: null, termos: null, log: "Pediu catálogo." });
      await enrichSupplierPageFromText("page-3", "texto");
      expect(appendToPageSection).toHaveBeenCalledTimes(1);
      const [pageId, content, section] = appendToPageSection.mock.calls[0]!;
      expect(pageId).toBe("page-3");
      expect(content).toMatch(/^\[\d{2}\/\d{2}\/\d{4}\] Pediu catálogo\.$/);
      expect(section).toBe("Log");
    });

    it("never throws when the underlying classifier call rejects", async () => {
      enrichSupplierFromTranscript.mockRejectedValue(new Error("API down"));
      await expect(enrichSupplierPageFromText("page-3", "texto")).resolves.toBeUndefined();
      expect(appendToPageSection).not.toHaveBeenCalled();
    });
  });
});
