/**
 * Studio Supabase client (kenko_customers, kenko_leads, etc.).
 *
 * Configured via STUDIO_SUPABASE_URL + STUDIO_SUPABASE_KEY env vars.
 * Returns `null` if either is missing so Supabase-dependent features
 * (birthday cron, etc.) can gracefully no-op instead of crashing the
 * bot at startup.
 */
import { createClient } from "@supabase/supabase-js";
import { log } from "./log.js";
const STUDIO_SUPABASE_URL = process.env.STUDIO_SUPABASE_URL;
const STUDIO_SUPABASE_KEY = process.env.STUDIO_SUPABASE_KEY;
let client = null;
if (STUDIO_SUPABASE_URL && STUDIO_SUPABASE_KEY) {
    client = createClient(STUDIO_SUPABASE_URL, STUDIO_SUPABASE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
    });
    log.info("studio_supabase.configured", { url: STUDIO_SUPABASE_URL });
}
else {
    log.warn("studio_supabase.disabled", {
        reason: !STUDIO_SUPABASE_URL ? "STUDIO_SUPABASE_URL missing" : "STUDIO_SUPABASE_KEY missing",
    });
}
export const studioSupabase = client;
export function isStudioSupabaseAvailable() {
    return client !== null;
}
