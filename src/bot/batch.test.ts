import { describe, expect, it } from "vitest";
import { isBatch, summarize, storeBatch, popBatch } from "./batch.js";
import type { Intent } from "../types.js";

const newTask: Intent = {
  type: "NEW_TASK",
  title: "x",
  owner: "Madalena",
  area: "Tech",
  why: "y",
  priority: "Média",
};
const logIntent: Intent = { type: "LOG", text: "z", tags: [] };

describe("batch", () => {
  it("isBatch true for >=3", () => {
    expect(isBatch([newTask, newTask])).toBe(false);
    expect(isBatch([newTask, newTask, newTask])).toBe(true);
  });

  it("summarize counts by type", () => {
    const out = summarize([newTask, newTask, logIntent]);
    expect(out).toContain("Vi 3 coisas");
    expect(out).toContain("2 tarefas novas");
    expect(out).toContain("1 anotações no log");
  });

  it("store + pop is one-shot", () => {
    const intents = [newTask];
    const id = storeBatch(intents);
    expect(popBatch(id)).toEqual(intents);
    expect(popBatch(id)).toBeNull();
  });
});
