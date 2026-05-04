import { describe, expect, it } from "vitest";
import { validateIntents } from "./multi-intent.js";
describe("validateIntents", () => {
    it("returns empty for non-object input", () => {
        expect(validateIntents(null)).toEqual([]);
        expect(validateIntents("nope")).toEqual([]);
        expect(validateIntents(42)).toEqual([]);
    });
    it("returns empty for missing intents array", () => {
        expect(validateIntents({})).toEqual([]);
        expect(validateIntents({ intents: "x" })).toEqual([]);
    });
    it("accepts a valid NEW_TASK", () => {
        const out = validateIntents({
            intents: [
                {
                    type: "NEW_TASK",
                    title: "contactar Sport Zone",
                    owner: "Madalena",
                    area: "Parcerias",
                    why: "fechar parceria",
                },
            ],
        });
        expect(out).toHaveLength(1);
        expect(out[0]?.type).toBe("NEW_TASK");
    });
    it("rejects NEW_TASK with bad owner", () => {
        const out = validateIntents({
            intents: [
                {
                    type: "NEW_TASK",
                    title: "x",
                    owner: "Pedro",
                    area: "Parcerias",
                    why: "y",
                },
            ],
        });
        expect(out).toEqual([]);
    });
    it("accepts REMINDER with valid ISO date", () => {
        const out = validateIntents({
            intents: [
                {
                    type: "REMINDER",
                    when: "2026-05-06T09:00:00+01:00",
                    text: "pedir status à CMC",
                    for: "all",
                },
            ],
        });
        expect(out).toHaveLength(1);
    });
    it("rejects REMINDER with bad date", () => {
        const out = validateIntents({
            intents: [
                {
                    type: "REMINDER",
                    when: "next wednesday",
                    text: "x",
                    for: "all",
                },
            ],
        });
        expect(out).toEqual([]);
    });
    it("accepts LOG and trims tags to 3", () => {
        const out = validateIntents({
            intents: [
                {
                    type: "LOG",
                    text: "vistoria CMC enviada",
                    tags: ["a", "b", "c", "d", "e"],
                },
            ],
        });
        expect(out).toHaveLength(1);
        expect(out[0].tags).toEqual(["a", "b", "c"]);
    });
    it("accepts EDIT_PENDING with cancel field and null value", () => {
        const out = validateIntents({
            intents: [
                { type: "EDIT_PENDING", ref: "t1", field: "cancel", value: null },
            ],
        });
        expect(out).toHaveLength(1);
    });
    it("drops invalid intents but keeps valid ones in same array", () => {
        const out = validateIntents({
            intents: [
                { type: "NEW_TASK", title: "x", owner: "Madalena", area: "Tech", why: "y" },
                { type: "BOGUS" },
                { type: "LOG", text: "z", tags: [] },
            ],
        });
        expect(out).toHaveLength(2);
        expect(out.map((i) => i.type)).toEqual(["NEW_TASK", "LOG"]);
    });
});
