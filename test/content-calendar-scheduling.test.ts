import { describe, expect, it } from "vitest";

import { alertKey, pruneStaleKeys } from "../src/lib/alert-dedup.js";
import { formatContentAlert } from "../src/messages/pipeline.js";
import type { ContentCalendarNeedsSchedulingRow } from "../src/types.js";

function row(
  overrides: Partial<ContentCalendarNeedsSchedulingRow> = {},
): ContentCalendarNeedsSchedulingRow {
  return {
    id: "row-1",
    title: "Post pilates pós-parto",
    date: "2026-07-17",
    status: "Planned",
    channel: "Instagram",
    ...overrides,
  };
}

describe("alertKey / pruneStaleKeys", () => {
  it("builds a key from rowId, type and scope", () => {
    expect(alertKey("abc", "content_calendar", "2026-07-16")).toBe(
      "abc|content_calendar|2026-07-16",
    );
    expect(alertKey("abc", "partner_no_response", 29)).toBe(
      "abc|partner_no_response|29",
    );
  });

  it("keeps keys matching the current week (partner/influencer style)", () => {
    const seen = ["abc|partner_no_response|29", "def|partner_no_response|28"];
    const stale = pruneStaleKeys(seen, 29, "2026-07-16");
    expect(stale).toEqual(["def|partner_no_response|28"]);
  });

  it("keeps keys matching today (content_calendar style)", () => {
    const seen = [
      "row-1|content_calendar|2026-07-16",
      "row-2|content_calendar|2026-07-15",
    ];
    const stale = pruneStaleKeys(seen, 29, "2026-07-16");
    expect(stale).toEqual(["row-2|content_calendar|2026-07-15"]);
  });

  it("prunes nothing when every key matches the current week or day", () => {
    const seen = ["abc|partner_no_response|29", "row-1|content_calendar|2026-07-16"];
    expect(pruneStaleKeys(seen, 29, "2026-07-16")).toEqual([]);
  });
});

describe("formatContentAlert", () => {
  it("lists each row with title, date, channel and status", () => {
    const text = formatContentAlert([row()]);
    expect(text).toContain("📅 conteúdo por agendar (próx. 2 dias):");
    expect(text).toContain("Post pilates pós-parto — 2026-07-17 [Instagram] (Planned)");
  });

  it("omits the channel bracket when channel is null", () => {
    const text = formatContentAlert([row({ channel: null })]);
    expect(text).toContain("Post pilates pós-parto — 2026-07-17 (Planned)");
    expect(text).not.toContain("[");
  });

  it("lists multiple rows, one per line", () => {
    const text = formatContentAlert([
      row({ id: "row-1", title: "A" }),
      row({ id: "row-2", title: "B", date: "2026-07-18", channel: "WhatsApp" }),
    ]);
    expect(text).toContain("A — 2026-07-17 [Instagram] (Planned)");
    expect(text).toContain("B — 2026-07-18 [WhatsApp] (Planned)");
  });
});
