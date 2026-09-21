import { describe, expect, it, vi } from "vitest";

import {
  extractViewsFromText,
  formatSourceLine,
  isWhyQuestion,
  lastSource,
  rememberSource,
} from "../src/lib/pulse-source.js";

describe("formatSourceLine", () => {
  it("names the views on one line", () => {
    expect(formatSourceLine(["v_pulse_membership_state", "v_pulse_pause_history"])).toBe(
      "Fonte: v_pulse_membership_state, v_pulse_pause_history",
    );
  });

  it("adds the data-as-of date when given", () => {
    expect(formatSourceLine(["v_pulse_membership_state"], "2026-09-18")).toBe(
      "Fonte: v_pulse_membership_state · dados até 18/09/2026",
    );
  });
});

describe("extractViewsFromText", () => {
  it("reads the views back out of a bot message", () => {
    expect(
      extractViewsFromText(
        "3 clientes em risco\n\nFonte: v_pulse_membership_state, v_pulse_pause_history · dados até 18/09/2026",
      ),
    ).toEqual(["v_pulse_membership_state", "v_pulse_pause_history"]);
  });

  it("is empty for a message with no Fonte line, or no text", () => {
    expect(extractViewsFromText("olá")).toEqual([]);
    expect(extractViewsFromText(undefined)).toEqual([]);
    expect(extractViewsFromText(null)).toEqual([]);
  });
});

describe("rememberSource / lastSource", () => {
  it("remembers per chat and ignores empty lists", () => {
    rememberSource(1, ["v_pulse_intro_purchase"]);
    rememberSource(1, []);
    expect(lastSource(1)).toEqual(["v_pulse_intro_purchase"]);
    expect(lastSource(2)).toEqual([]);
  });
});

describe("isWhyQuestion", () => {
  it.each(["porquê?", "Porquê", "porque?", "e porquê?", "why?", "Why", "por que?", "porquê??"])(
    "matches %s",
    (t) => {
      expect(isWhyQuestion(t)).toBe(true);
    },
  );

  it.each(["porque é que a Ana não aparece?", "why is this here", "ok", "porquê a Esen?"])(
    "does not match %s",
    (t) => {
      expect(isWhyQuestion(t)).toBe(false);
    },
  );
});

const sendGroupMessage = vi.fn().mockResolvedValue(42);
vi.mock("../src/lib/telegram.js", () => ({
  sendGroupMessage: (...args: unknown[]) => sendGroupMessage(...args),
}));

describe("sendGroupMessageWithSource", () => {
  it("appends the Fonte line (and a pending note) and remembers the views for the group", async () => {
    process.env.TELEGRAM_GROUP_ID = "-100123";
    const { sendGroupMessageWithSource, lastSource: last } = await import("../src/lib/pulse-source.js");
    const id = await sendGroupMessageWithSource(
      "3 em risco",
      ["v_pulse_membership_state"],
      "2026-09-18",
      "sinais ainda sem view (casos #16, #17, #19)",
    );
    expect(id).toBe(42);
    expect(sendGroupMessage).toHaveBeenCalledWith(
      "3 em risco\n\nFonte: v_pulse_membership_state · dados até 18/09/2026\nsinais ainda sem view (casos #16, #17, #19)",
      undefined,
    );
    expect(last(-100123)).toEqual(["v_pulse_membership_state"]);
  });
});
