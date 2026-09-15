import "./helpers/notion-env.js";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { parseRemindCommand } from "../src/bot/remind.js";

// This suite is specifically about the container-TZ=Europe/Lisbon assumption
// (see docker-compose.yml) that `/remind amanhã` and `/remind <dia>` rely on
// via `at9amLisbon` (src/bot/remind.ts). Pinning process.env.TZ here makes
// the test deterministic regardless of the machine running it, and matches
// the real deployment rather than sidestepping the assumption.
describe("parseRemindCommand — 09:00 Lisbon anchor (amanhã / weekday)", () => {
  const originalTz = process.env.TZ;

  beforeAll(() => {
    process.env.TZ = "Europe/Lisbon";
  });

  afterAll(() => {
    process.env.TZ = originalTz;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("amanhã resolves to 09:00 Lisbon during DST (WEST, UTC+1)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-14T12:00:00.000Z")); // 2026-09-14 = Monday, WEST
    const result = parseRemindCommand("/remind amanhã rever pipeline", "Madalena");
    expect(result.parsed).toBe(true);
    // 09:00 Lisbon on 2026-09-15 (WEST, UTC+1) = 08:00 UTC
    expect(result.reminder?.quando).toBe("2026-09-15T08:00:00.000Z");
  });

  it("amanhã resolves to 09:00 Lisbon during winter (WET, UTC+0)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-14T12:00:00.000Z")); // WET, no DST offset
    const result = parseRemindCommand("/remind amanhã rever pipeline", "Madalena");
    expect(result.parsed).toBe(true);
    expect(result.reminder?.quando).toBe("2026-01-15T09:00:00.000Z");
  });

  it("a weekday name (sexta) resolves to 09:00 Lisbon during DST", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-14T12:00:00.000Z")); // Monday; next Friday = 2026-09-18
    const result = parseRemindCommand("/remind sexta enviar relatório", "Madalena");
    expect(result.parsed).toBe(true);
    expect(result.reminder?.quando).toBe("2026-09-18T08:00:00.000Z");
  });

  it("a plain hour offset (2h) is unaffected by the Lisbon-anchor path", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-14T12:00:00.000Z"));
    const result = parseRemindCommand("/remind 2h ligar à madalena", "Madalena");
    expect(result.parsed).toBe(true);
    expect(result.reminder?.quando).toBe("2026-09-14T14:00:00.000Z");
  });
});
