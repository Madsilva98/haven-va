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
