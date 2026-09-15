import { describe, expect, it } from "vitest";

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
