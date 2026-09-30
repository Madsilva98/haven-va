import { describe, expect, it } from "vitest";

import { buildVerdictPrompt, parseVerdict } from "../src/lib/mail-verdict.js";

describe("parseVerdict", () => {
  it("reads a well-formed answer, even with text around the JSON", () => {
    expect(
      parseVerdict('Aqui está:\n{"tipo":"FORNECEDOR","fatura_fornecedor":false,"precisa_acao":true,"razao":"negociação em curso"}'),
    ).toEqual({ tipo: "fornecedor", isSupplierInvoice: false, needsAction: true, reason: "negociação em curso" });
  });

  it("maps CANDIDATURA", () => {
    expect(parseVerdict('{"tipo":"CANDIDATURA","fatura_fornecedor":false,"precisa_acao":true,"razao":"x"}')?.tipo).toBe(
      "candidatura",
    );
  });

  it("undecided (null) on anything it can't fully trust", () => {
    expect(parseVerdict("PARCEIRO")).toBeNull();
    expect(parseVerdict('{"tipo":"PARCEIRO"}')).toBeNull(); // missing booleans
    expect(parseVerdict('{"tipo":"SPAM","fatura_fornecedor":false,"precisa_acao":false}')).toBeNull(); // unknown tipo
    expect(parseVerdict('{"tipo":"OUTRO","fatura_fornecedor":"no","precisa_acao":false}')).toBeNull(); // not boolean
    expect(parseVerdict("{not json}")).toBeNull();
  });
});

describe("buildVerdictPrompt", () => {
  it("includes attachments and the later Haven reply when present", () => {
    const p = buildVerdictPrompt({
      mailbox: "geral@x.pt",
      fromName: "A",
      fromEmail: "a@y.pt",
      to: ["geral@x.pt"],
      subject: "S",
      body: "B",
      attachmentNames: ["fatura.pdf"],
      laterReplyBody: "já tratámos",
    });
    expect(p).toContain("Anexos: fatura.pdf");
    expect(p).toContain("já tratámos");
  });
});
