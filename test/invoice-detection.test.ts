import { describe, expect, it } from "vitest";

import { invoiceCandidateAttachments, mentionsInvoice } from "../src/lib/invoice-detection.js";

const pdf = (name: string) => ({ name, contentType: "application/pdf", size: 1000 });

describe("mentionsInvoice", () => {
  it("matches whole words, with _ and - as separators", () => {
    expect(mentionsInvoice("fatura_setembro.pdf")).toBe(true);
    expect(mentionsInvoice("Invoice-2026-0042.pdf")).toBe(true);
    expect(mentionsInvoice("Fatura-Recibo FR 2026/12")).toBe(true);
    expect(mentionsInvoice("Factura Amazon")).toBe(true);
  });

  it("does not match inside longer words", () => {
    expect(mentionsInvoice("dados de faturação")).toBe(false);
    expect(mentionsInvoice("vamos faturar em outubro")).toBe(false);
  });
});

describe("invoiceCandidateAttachments", () => {
  it("rejects the real false positive: a supplier's quote (2026-09-28)", () => {
    // lipclean.trans@gmail.com — body mentioned billing, subject/file did not say invoice
    expect(invoiceCandidateAttachments("Proposta de orçamento", [pdf("orcamento_haven.pdf")])).toBeNull();
  });

  it("ignores the body entirely — only subject and filenames count", () => {
    expect(invoiceCandidateAttachments("Contrato para assinar", [pdf("Contrato_Haven.pdf")])).toBeNull();
  });

  it("vetoes a quote even if the subject also says fatura", () => {
    expect(
      invoiceCandidateAttachments("Orçamento e condições de fatura", [pdf("proposta.pdf")]),
    ).toBeNull();
  });

  it("keeps a filename that itself names an invoice, even in a quote thread", () => {
    expect(
      invoiceCandidateAttachments("Re: Proposta de orçamento", [pdf("Fatura_FT2026-12.pdf")]),
    ).toHaveLength(1);
  });

  it("accepts an invoice by filename or subject", () => {
    expect(invoiceCandidateAttachments("Documentos", [pdf("fatura_setembro.pdf")])).toHaveLength(1);
    expect(invoiceCandidateAttachments("A sua fatura de setembro", [pdf("doc123.pdf")])).toHaveLength(1);
  });

  it("needs a PDF or image attachment", () => {
    expect(
      invoiceCandidateAttachments("Fatura", [{ name: "fatura.xlsx", contentType: "application/vnd.ms-excel", size: 1 }]),
    ).toBeNull();
  });
});
