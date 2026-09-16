import { beforeAll, describe, expect, it } from "vitest";

// Regression test for a real 2026-09-15 incident: @supabase/supabase-js's
// createClient() always constructs a RealtimeClient internally, which
// throws synchronously on Node 20 (this bot's runtime) without a
// WebSocket implementation — crashing the whole process at startup the
// moment real STUDIO_SUPABASE_URL/KEY values are configured. Fixed by
// passing the `ws` package as realtime.transport (see
// src/lib/studio-supabase.ts). This test sets fake-but-present env vars
// (no real network call is made — construction alone was what crashed)
// and asserts the module loads without throwing.
describe("studio-supabase client construction", () => {
  it("does not throw when STUDIO_SUPABASE_URL/KEY are set (Node 20 WebSocket transport fix)", async () => {
    process.env.STUDIO_SUPABASE_URL = "https://example.supabase.co";
    process.env.STUDIO_SUPABASE_KEY = "dummy-key-for-construction-test-only";

    const mod = await import("../src/lib/studio-supabase.js");
    expect(mod.isStudioSupabaseAvailable()).toBe(true);
    expect(mod.studioSupabase).not.toBeNull();
  });
});

// Regression test for a real 2026-09-16 incident: PostgREST (and
// supabase-js by extension) silently caps an unranged select at 1000 rows
// — no error, no warning. A query fetching kenko_bookings whole was
// missing most of a person's attendance history as a result. fetchAllPages
// exists specifically so every table-scan query in this codebase pages
// through the full result set instead of trusting a bare .select().
describe("fetchAllPages", () => {
  // Dynamic import, same reasoning as the construction test above — this
  // file must never let a static top-level import of studio-supabase.js
  // force module evaluation before a test has set its own env vars.
  let fetchAllPages: (typeof import("../src/lib/studio-supabase.js"))["fetchAllPages"];
  beforeAll(async () => {
    ({ fetchAllPages } = await import("../src/lib/studio-supabase.js"));
  });

  function makeFakeTable(totalRows: number, pageSize: number) {
    const allRows = Array.from({ length: totalRows }, (_, i) => ({ id: i }));
    let calls = 0;
    const queryFactory = (from: number, to: number) => {
      calls++;
      return Promise.resolve({ data: allRows.slice(from, to + 1), error: null });
    };
    return { queryFactory, getCalls: () => calls, pageSize };
  }

  it("returns every row across multiple pages, not just the first 1000", async () => {
    const { queryFactory } = makeFakeTable(2500, 1000);
    const rows = await fetchAllPages(queryFactory);
    expect(rows).toHaveLength(2500);
  });

  it("stops after the first short page instead of always doing a trailing empty request", async () => {
    const { queryFactory, getCalls } = makeFakeTable(2500, 1000);
    await fetchAllPages(queryFactory);
    // 2500 rows / 1000-per-page = pages of 1000, 1000, 500 — the 500-row
    // page is itself < 1000, so that's the stopping signal (3 calls total,
    // not a 4th call that would return an empty page).
    expect(getCalls()).toBe(3);
  });

  it("makes exactly one call for a table smaller than the page size", async () => {
    const { queryFactory, getCalls } = makeFakeTable(50, 1000);
    const rows = await fetchAllPages(queryFactory);
    expect(rows).toHaveLength(50);
    expect(getCalls()).toBe(1);
  });

  it("throws on a page-fetch error instead of silently returning a partial result", async () => {
    const queryFactory = () => Promise.resolve({ data: null, error: { message: "boom" } });
    await expect(fetchAllPages(queryFactory)).rejects.toThrow("boom");
  });
});
