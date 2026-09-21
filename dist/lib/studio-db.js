/**
 * The bot's Postgres connection to the studio project: role `haven_va`,
 * search_path `va`, over STUDIO_DATABASE_URL (the Supabase pooler string).
 * What that role can see is decided in the studio repo
 * (packages/dashboard/supabase/va-schema-and-role-migration.sql): select on
 * every va.v_pulse_* view, insert on va.pulse_cases, nothing on public.
 * Postgres enforces it, not this file. Replaced the service-role
 * supabase-js client 2026-09-21 — a stolen bot key used to be a full PII
 * dump; now it is a view of curated numbers plus one flag channel.
 *
 * Returns `null` when the URL is missing so every studio-backed cron can
 * log and no-op instead of crashing the bot at startup.
 *
 * Statement timeout is set on the role (30s). Every date column comes back
 * as "YYYY-MM-DD" text (the DATE type parser below), never a JS Date — the
 * v_pulse_* views compare as plain strings.
 */
import pg from "pg";
import { log } from "./log.js";
const STUDIO_DATABASE_URL = process.env.STUDIO_DATABASE_URL;
// 1082 = DATE. Keep it as the "YYYY-MM-DD" string Postgres sends; pg's
// default would build a local-midnight Date and shift it across timezones.
pg.types.setTypeParser(1082, (v) => v);
// 1700 = NUMERIC — a number is fine for the amounts and percentages here.
pg.types.setTypeParser(1700, (v) => Number(v));
let pool = null;
if (STUDIO_DATABASE_URL) {
    pool = new pg.Pool({
        connectionString: STUDIO_DATABASE_URL,
        max: 3, // the role's connection limit is 5; leave room for a psql session
        idleTimeoutMillis: 30_000,
        connectionTimeoutMillis: 10_000,
        ssl: { rejectUnauthorized: process.env.STUDIO_DATABASE_SSL_NO_VERIFY !== "1" },
    });
    pool.on("error", (err) => log.error("studio_db.pool_error", { message: err.message }));
    log.info("studio_db.configured", { host: safeHost(STUDIO_DATABASE_URL) });
}
else {
    log.warn("studio_db.disabled", { reason: "STUDIO_DATABASE_URL missing" });
}
function safeHost(url) {
    try {
        return new URL(url).host;
    }
    catch {
        return "?";
    }
}
export function isStudioDbAvailable() {
    return pool !== null;
}
export async function query(text, params = []) {
    if (!pool)
        throw new Error("studio_db: STUDIO_DATABASE_URL not configured");
    const res = await pool.query(text, params);
    return res.rows;
}
/** Run `fn` on one client inside a transaction (needed for currval after an
 * insert: the pooler is in transaction mode, so two plain queries may land
 * on different backends). */
export async function withTransaction(fn) {
    if (!pool)
        throw new Error("studio_db: STUDIO_DATABASE_URL not configured");
    const client = await pool.connect();
    try {
        await client.query("begin");
        const out = await fn(client);
        await client.query("commit");
        return out;
    }
    catch (err) {
        await client.query("rollback").catch(() => undefined);
        throw err;
    }
    finally {
        client.release();
    }
}
