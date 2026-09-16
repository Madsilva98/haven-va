/**
 * Studio Supabase client (kenko_customers, kenko_leads, etc.).
 *
 * Configured via STUDIO_SUPABASE_URL + STUDIO_SUPABASE_KEY env vars.
 * Returns `null` if either is missing so Supabase-dependent features
 * (birthday cron, etc.) can gracefully no-op instead of crashing the
 * bot at startup.
 *
 * `realtime.transport` is required on Node 20 (this bot's runtime, see
 * `engines` in package.json): @supabase/supabase-js always constructs a
 * RealtimeClient inside `createClient`, even though this bot never
 * subscribes to anything, and that constructor throws synchronously if
 * it can't find a WebSocket implementation — Node only got a native
 * global `WebSocket` in v22. Without this, `createClient` crashes the
 * whole process at startup the moment real credentials are configured
 * (found the hard way, 2026-09-15 — see docs/knowledge-base/
 * bot-architecture.md). The `ws` package supplies that implementation;
 * nothing here ever calls `.channel()`/`.subscribe()`, so it's inert
 * otherwise.
 */

import {
  createClient,
  type SupabaseClient,
  type WebSocketLikeConstructor,
} from "@supabase/supabase-js";
import WebSocket from "ws";

import { log } from "./log.js";

const STUDIO_SUPABASE_URL = process.env.STUDIO_SUPABASE_URL;
const STUDIO_SUPABASE_KEY = process.env.STUDIO_SUPABASE_KEY;

let client: SupabaseClient | null = null;

if (STUDIO_SUPABASE_URL && STUDIO_SUPABASE_KEY) {
  client = createClient(STUDIO_SUPABASE_URL, STUDIO_SUPABASE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    realtime: { transport: WebSocket as unknown as WebSocketLikeConstructor },
  });
  log.info("studio_supabase.configured", { url: STUDIO_SUPABASE_URL });
} else {
  log.warn("studio_supabase.disabled", {
    reason: !STUDIO_SUPABASE_URL ? "STUDIO_SUPABASE_URL missing" : "STUDIO_SUPABASE_KEY missing",
  });
}

export const studioSupabase = client;

export function isStudioSupabaseAvailable(): boolean {
  return client !== null;
}

// PostgREST (and by extension supabase-js) caps a single select at 1000
// rows by default — a query with no .range() silently returns only the
// first page, no error, no warning. Found the hard way 2026-09-16:
// kenko_bookings has 3425+ checkin_status='Yes' rows, and every call site
// that fetched it whole (visit history, churn signals' booking window)
// was quietly missing most of them. Any query that scans a table which
// could plausibly exceed 1000 rows — now or as the studio grows — must
// go through this, not a bare .select().
const SUPABASE_PAGE_SIZE = 1000;

export interface SupabasePage<T> {
  data: T[] | null;
  error: { message: string } | null;
}

/**
 * `queryFactory(from, to)` must build a FRESH query each call and apply
 * `.range(from, to)` to it itself, e.g.:
 *   fetchAllPages((from, to) =>
 *     studioSupabase.from("t").select("c").eq("x", 1).range(from, to))
 * Stops (and returns what it has) on the first page shorter than
 * SUPABASE_PAGE_SIZE; throws on the first page-fetch error.
 */
export async function fetchAllPages<T>(
  queryFactory: (from: number, to: number) => PromiseLike<SupabasePage<T>>,
): Promise<T[]> {
  const rows: T[] = [];
  let from = 0;
  for (;;) {
    const { data, error } = await queryFactory(from, from + SUPABASE_PAGE_SIZE - 1);
    if (error) throw new Error(error.message);
    rows.push(...(data ?? []));
    if (!data || data.length < SUPABASE_PAGE_SIZE) break;
    from += SUPABASE_PAGE_SIZE;
  }
  return rows;
}
