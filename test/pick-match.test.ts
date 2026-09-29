import { describe, expect, it } from "vitest";

import { pickMatch, scoreTitle } from "../src/lib/pick-match.js";

const c = (id: string, title: string) => ({ id, title });

describe("pickMatch", () => {
  it("matches an exact title even when other items share words", () => {
    expect(pickMatch("leite", [c("1", "leite de aveia"), c("2", "Leite")])).toEqual({
      kind: "match",
      id: "2",
      title: "Leite",
    });
  });

  it("matches the single strong candidate", () => {
    expect(pickMatch("aveia", [c("1", "leite de aveia"), c("2", "pão")])).toMatchObject({ kind: "match", id: "1" });
  });

  it("asks when several items are equally plausible", () => {
    expect(pickMatch("leite", [c("1", "leite de aveia"), c("2", "leite de amêndoa")])).toEqual({
      kind: "ambiguous",
      titles: ["leite de aveia", "leite de amêndoa"],
    });
  });

  it("asks rather than deleting on a single weak shared word (the old bug)", () => {
    // "comprar tapetes novos" vs "tapetes antiderrapantes para a sala": 1/4 words overlap
    expect(pickMatch("comprar tapetes novos", [c("1", "tapetes antiderrapantes para a sala")])).toEqual({
      kind: "ambiguous",
      titles: ["tapetes antiderrapantes para a sala"],
    });
  });

  it("returns none when nothing shares a word", () => {
    expect(pickMatch("velas", [c("1", "toalhas")])).toEqual({ kind: "none" });
  });

  it("never lets an empty title match everything", () => {
    expect(scoreTitle("renda", "")).toBe(0);
    expect(pickMatch("renda", [c("1", "")])).toEqual({ kind: "none" });
  });

  it("cancels the one reminder when only one contains the text, asks when several do", () => {
    expect(pickMatch("renda", [c("1", "pagar renda do estúdio")])).toMatchObject({ kind: "match", id: "1" });
    expect(
      pickMatch("renda", [c("1", "pagar renda do estúdio"), c("2", "renda de outubro — enviar comprovativo")]),
    ).toMatchObject({ kind: "ambiguous" });
  });
});
