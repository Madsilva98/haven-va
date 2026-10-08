import { describe, expect, it } from "vitest";

import {
  COMPETITORS_PAGE_URL,
  formatCompetitorMovements,
  thisWeeksMovements,
} from "../src/messages/competitor-movements.js";
import type { CompetitorInnovation, CompetitorMovementsStatus } from "../src/types.js";

const TODAY = "2026-10-12";

function item(o: Partial<CompetitorInnovation>): CompetitorInnovation {
  return { id: "ig-x", type: "Offers & campaigns", t: "Title", who: "KORE", wk: TODAY, pt: "Nova oferta.", ...o };
}

function status(o: Partial<CompetitorMovementsStatus> = {}): CompetitorMovementsStatus {
  return {
    date: TODAY,
    ok: true,
    instagram: { ok: true },
    websites: { ok: true },
    newsletters: { ok: true },
    failures: [],
    ...o,
  };
}

describe("thisWeeksMovements", () => {
  it("keeps items found in the 7 days up to today, drops older, future and hand-written ones", () => {
    const items = [
      item({ id: "a", wk: "2026-10-12" }),
      item({ id: "b", wk: "2026-10-06" }),
      item({ id: "c", wk: "2026-10-05" }),
      item({ id: "d", wk: "2026-10-13" }),
      item({ id: "e", wk: undefined }),
    ];
    expect(thisWeeksMovements(items, TODAY).map((i) => i.id)).toEqual(["a", "b"]);
  });
});

describe("formatCompetitorMovements", () => {
  it("groups this week's breaks by kind, with the pt line, studio and link", () => {
    const out = formatCompetitorMovements({
      today: TODAY,
      status: status(),
      intelErrors: 0,
      innovations: [
        item({ id: "1", type: "Events", who: "Contrast Club", pt: "Primeiro book club.", url: "https://www.instagram.com/p/A_b/" }),
        item({ id: "2", type: "Offers & campaigns", who: "KORE", pt: "Passa a créditos: 1 aula = 2 créditos." }),
        item({ id: "3", type: "Partnerships", wk: "2026-09-29", pt: "antiga" }),
      ],
    });
    expect(out).toContain("*eventos*");
    expect(out).toContain("*ofertas e preços*");
    expect(out.indexOf("ofertas e preços")).toBeLessThan(out.indexOf("eventos"));
    expect(out).toContain("*Contrast Club* — Primeiro book club\\.");
    expect(out).toContain("[ver](https://www.instagram.com/p/A_b/)");
    expect(out).toContain("1 aula \\= 2 créditos");
    expect(out).not.toContain("antiga");
    expect(out).not.toContain("parcerias");
    expect(out).toContain(COMPETITORS_PAGE_URL);
    expect(out).not.toContain("⚠️");
  });

  it("says nothing out of the ordinary on a quiet week", () => {
    const out = formatCompetitorMovements({ today: TODAY, status: status(), intelErrors: 0, innovations: [] });
    expect(out).toContain("nada fora do habitual esta semana");
  });

  it("counts positioning changes instead of listing them", () => {
    const out = formatCompetitorMovements({
      today: TODAY,
      status: status(),
      intelErrors: 0,
      innovations: [item({ type: "Positioning & message", pt: "Agora diz-se clube." })],
    });
    expect(out).not.toContain("Agora diz-se clube");
    expect(out).toContain("1 mudança\\(s\\) de posicionamento");
    expect(out).toContain("nada fora do habitual");
  });

  it("warns when the weekly analysis didn't run (no status, or an old one)", () => {
    for (const s of [null, status({ date: "2026-10-05" })]) {
      const out = formatCompetitorMovements({ today: TODAY, status: s, intelErrors: 0, innovations: [] });
      expect(out).toContain("não correu esta semana");
    }
  });

  it("names the sources that failed", () => {
    const out = formatCompetitorMovements({
      today: TODAY,
      status: status({ ok: false, newsletters: { ok: false, error: "Notion HTTP 404" }, failures: [{ studio: "kore", error: "x" }] }),
      intelErrors: 2,
      innovations: [],
    });
    expect(out).toContain("correu com falhas \\(newsletters, 1 estúdio\\(s\\)\\)");
    expect(out).toContain("2 newsletter\\(s\\) com erro");
  });

  it("escapes a ) in a link so MarkdownV2 doesn't end it early", () => {
    const out = formatCompetitorMovements({
      today: TODAY,
      status: status(),
      intelErrors: 0,
      innovations: [item({ url: "https://site.pt/a_(b)" })],
    });
    expect(out).toContain("(https://site.pt/a_(b\\))");
  });
});
