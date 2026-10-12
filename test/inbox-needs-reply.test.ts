import { describe, expect, it } from "vitest";

import { buildTranscript, formatDigest, parseVerdict, type InboxWaitingRow } from "../src/lib/inbox-needs-reply.js";

describe("parseVerdict", () => {
  it("reads the one-line JSON, clamps numbers and maps an unknown category to other", () => {
    expect(parseVerdict('{"state":"needs_reply","category":"booking_or_price","urgency":0.8,"confidence":0.9,"reason":"Pergunta preço do pack."}'))
      .toEqual({ state: "needs_reply", category: "booking_or_price", urgency: 0.8, confidence: 0.9, reason: "Pergunta preço do pack." });
    expect(parseVerdict('Sure: {"state":"closed","category":"weird","urgency":7,"confidence":-1,"reason":"Agradeceu."}'))
      .toEqual({ state: "closed", category: "other", urgency: 1, confidence: 0, reason: "Agradeceu." });
  });
  it("refuses anything without a valid state, so nothing is written and the thread stays in the queue", () => {
    expect(parseVerdict("needs reply")).toBeNull();
    expect(parseVerdict('{"state":"maybe"}')).toBeNull();
    expect(parseVerdict("{not json}")).toBeNull();
  });
});

describe("buildTranscript", () => {
  it("labels who spoke and stands in for media", () => {
    expect(buildTranscript([
      { direction: "in", text: "Olá! Quanto custa o pack de 5?", sent_at: "2026-10-12 19:59:37.607+00" },
      { direction: "out", text: null, sent_at: "2026-10-12 20:01:00+00" },
    ])).toBe("Pessoa (2026-10-12 19:59): Olá! Quanto custa o pack de 5?\nThe Haven (2026-10-12 20:01): [foto, vídeo ou partilha]");
  });
});

const row = (o: Partial<InboxWaitingRow>): InboxWaitingRow => ({
  username: "ana.pilates", display_name: "Ana", is_lead: true,
  last_in_at: "2026-10-13 07:00:00+00", window_closes_at: "2026-10-14 07:00:00+00", human_agent_until: "2026-10-20 07:00:00+00",
  state: "needs_reply", category: "booking_or_price", urgency: 0.7, reason: "Pergunta horários de sábado.", ...o,
});

describe("formatDigest", () => {
  const now = new Date("2026-10-13T09:30:00Z");
  it("sends nothing when nobody is waiting", () => {
    expect(formatDigest([], now, false)).toBeNull();
  });
  it("shows who, what, how long they waited and the window", () => {
    const out = formatDigest([row({})], now, false)!;
    expect(out).toContain("1 pessoa à espera");
    expect(out).toContain("• @ana.pilates · lead · booking or price · há 3h · janela fecha em 22h");
    expect(out).toContain("Pergunta horários de sábado.");
    expect(out).not.toContain("Semana de teste");
  });
  it("says when only a manual reply is still possible, and flags unjudged threads", () => {
    const out = formatDigest([row({ username: null, display_name: "Rita", is_lead: false, state: "unlabelled", category: null, reason: null,
      last_in_at: "2026-10-11 09:00:00+00", window_closes_at: "2026-10-12 09:00:00+00" })], now, true)!;
    expect(out).toContain("• Rita · por classificar · há 49h · janela de 24h fechou: só resposta escrita à mão até 20/10");
    expect(out).toContain("Semana de teste");
  });
});
