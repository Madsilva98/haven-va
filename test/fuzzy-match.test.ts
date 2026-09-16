import { describe, expect, it } from "vitest";

import { normalizeText, scoreMatch, significantWords } from "../src/lib/fuzzy-match.js";

describe("normalizeText", () => {
  it("strips diacritics and lowercases", () => {
    expect(normalizeText("Conceição")).toBe("conceicao");
    expect(normalizeText("MAFALDA")).toBe("mafalda");
  });
});

describe("scoreMatch", () => {
  it("scores an exact match (after normalization) as 1", () => {
    expect(scoreMatch("Conceição", "conceicao")).toBe(1);
  });

  it("scores a substring match as 0.8", () => {
    expect(scoreMatch("Maria Conceição Silva", "conceicao")).toBe(0.8);
  });

  it("scores partial word overlap between 0 and 1", () => {
    const score = scoreMatch("Ana Beatriz Rogério", "ana rogerio");
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(1);
  });

  it("scores completely unrelated strings as 0", () => {
    expect(scoreMatch("Track & Field", "xyz")).toBe(0);
  });
});

describe("significantWords", () => {
  it("drops Portuguese stopwords and short tokens", () => {
    expect(significantWords("o parceiro da Haven")).toEqual(["parceiro", "haven"]);
  });
});
