import { describe, expect, it } from "vitest";

import {
  COMPETITORS_PAGE_URL,
  formatCompetitorMovements,
  thisWeeksMovements,
} from "../src/messages/competitor-movements.js";
import type { CompetitorInnovation, CompetitorMovementsStatus } from "../src/types.js";

const TODAY = "2026-10-12";

function item(o: Partial<CompetitorInnovation>): CompetitorInnovation {
  return { id: "ig-x", type: "Offers & campaigns", t: "Title", who: "KORE", wk: TODAY, pt: "Nova oferta.", m: 3, ...o };
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

const ok = { today: TODAY, status: status(), intelErrors: 0 };

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

  it("orders by m, keeping the written order within a score", () => {
    const items = [item({ id: "a", m: 2 }), item({ id: "b", m: 5 }), item({ id: "c", m: 2 }), item({ id: "d" , m: undefined })];
    expect(thisWeeksMovements(items, TODAY).map((i) => i.id)).toEqual(["b", "a", "c", "d"]);
  });
});

describe("formatCompetitorMovements (key points only)", () => {
  it("shows the week's top 3 by m and counts the rest, linking to the page", () => {
    const out = formatCompetitorMovements({
      ...ok,
      innovations: [
        item({ id: "1", m: 2, pt: "Ulla lança aula de alongamentos." }),
        item({ id: "2", m: 5, pt: "Holmes Place inclui Reformer ilimitado: 195€/mês." }),
        item({ id: "3", m: 4, pt: "Preços para estudantes em 3 estúdios." }),
        item({ id: "4", m: 5, pt: "Amplify faz evento em Cascais (10 out)." }),
        item({ id: "5", m: 1, pt: "OREN lança passaporte." }),
        item({ id: "6", m: 5, wk: "2026-09-29", pt: "antiga" }),
      ],
    });
    const lines = out.split("\n");
    expect(lines[0]).toBe("*concorrência — semana*");
    expect(lines[1]).toBe("• Holmes Place inclui Reformer ilimitado: 195€/mês\\.");
    expect(lines[2]).toBe("• Amplify faz evento em Cascais \\(10 out\\)\\.");
    expect(lines[3]).toBe("• Preços para estudantes em 3 estúdios\\.");
    expect(lines[4]).toBe(`\\+2 na [página Competitors](${COMPETITORS_PAGE_URL})`);
    expect(lines).toHaveLength(5);
    expect(out).not.toContain("antiga");
  });

  it("has no count line when there are 3 or fewer", () => {
    const out = formatCompetitorMovements({ ...ok, innovations: [item({ pt: "Só uma." })] });
    expect(out.split("\n")).toEqual(["*concorrência — semana*", "• Só uma\\.", `[página Competitors](${COMPETITORS_PAGE_URL})`]);
  });

  it("falls back to studio and title when there is no pt line", () => {
    const out = formatCompetitorMovements({ ...ok, innovations: [item({ pt: undefined, who: "Ulla", t: "Stretch class" })] });
    expect(out).toContain("• Ulla: Stretch class");
  });

  it("says nothing out of the ordinary on a quiet week", () => {
    const out = formatCompetitorMovements({ ...ok, innovations: [] });
    expect(out).toContain("nada fora do habitual esta semana");
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
});
