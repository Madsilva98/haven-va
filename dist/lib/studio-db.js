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
 * Statement timeout is set on the role (30s). Every date and timestamp column
 * comes back as text (the type parsers below), never a JS Date — the
 * v_pulse_* views compare as plain strings.
 */
import pg from "pg";
import { log } from "./log.js";
const STUDIO_DATABASE_URL = process.env.STUDIO_DATABASE_URL;
// Supabase's pooler serves a leaf cert chaining to Supabase's own root CA
// ("Supabase Root 2021 CA"), not a publicly-trusted one — Node's bundled
// trust store doesn't include it, so a plain TLS connect fails with
// "self-signed certificate in certificate chain" even though the
// connection is legitimate. Pinning this root (captured directly from the
// pooler's live handshake, same cert Supabase calls prod-ca-2021.crt) lets
// the pg client verify properly instead of disabling verification.
const SUPABASE_ROOT_CA = `-----BEGIN CERTIFICATE-----
MIIDxDCCAqygAwIBAgIUbLxMod62P2ktCiAkxnKJwtE9VPYwDQYJKoZIhvcNAQEL
BQAwazELMAkGA1UEBhMCVVMxEDAOBgNVBAgMB0RlbHdhcmUxEzARBgNVBAcMCk5l
dyBDYXN0bGUxFTATBgNVBAoMDFN1cGFiYXNlIEluYzEeMBwGA1UEAwwVU3VwYWJh
c2UgUm9vdCAyMDIxIENBMB4XDTIxMDQyODEwNTY1M1oXDTMxMDQyNjEwNTY1M1ow
azELMAkGA1UEBhMCVVMxEDAOBgNVBAgMB0RlbHdhcmUxEzARBgNVBAcMCk5ldyBD
YXN0bGUxFTATBgNVBAoMDFN1cGFiYXNlIEluYzEeMBwGA1UEAwwVU3VwYWJhc2Ug
Um9vdCAyMDIxIENBMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAqQXW
QyHOB+qR2GJobCq/CBmQ40G0oDmCC3mzVnn8sv4XNeWtE5XcEL0uVih7Jo4Dkx1Q
DmGHBH1zDfgs2qXiLb6xpw/CKQPypZW1JssOTMIfQppNQ87K75Ya0p25Y3ePS2t2
GtvHxNjUV6kjOZjEn2yWEcBdpOVCUYBVFBNMB4YBHkNRDa/+S4uywAoaTWnCJLUi
cvTlHmMw6xSQQn1UfRQHk50DMCEJ7Cy1RxrZJrkXXRP3LqQL2ijJ6F4yMfh+Gyb4
O4XajoVj/+R4GwywKYrrS8PrSNtwxr5StlQO8zIQUSMiq26wM8mgELFlS/32Uclt
NaQ1xBRizkzpZct9DwIDAQABo2AwXjALBgNVHQ8EBAMCAQYwHQYDVR0OBBYEFKjX
uXY32CztkhImng4yJNUtaUYsMB8GA1UdIwQYMBaAFKjXuXY32CztkhImng4yJNUt
aUYsMA8GA1UdEwEB/wQFMAMBAf8wDQYJKoZIhvcNAQELBQADggEBAB8spzNn+4VU
tVxbdMaX+39Z50sc7uATmus16jmmHjhIHz+l/9GlJ5KqAMOx26mPZgfzG7oneL2b
VW+WgYUkTT3XEPFWnTp2RJwQao8/tYPXWEJDc0WVQHrpmnWOFKU/d3MqBgBm5y+6
jB81TU/RG2rVerPDWP+1MMcNNy0491CTL5XQZ7JfDJJ9CCmXSdtTl4uUQnSuv/Qx
Cea13BX2ZgJc7Au30vihLhub52De4P/4gonKsNHYdbWjg7OWKwNv/zitGDVDB9Y2
CMTyZKG3XEu5Ghl1LEnI3QmEKsqaCLv12BnVjbkSeZsMnevJPs1Ye6TjjJwdik5P
o/bKiIz+Fq8=
-----END CERTIFICATE-----`;
// 1082 = DATE. Keep it as the "YYYY-MM-DD" string Postgres sends; pg's
// default would build a local-midnight Date and shift it across timezones.
pg.types.setTypeParser(1082, (v) => v);
// 1114 / 1184 = TIMESTAMP / TIMESTAMPTZ. Strings as well (inbox_messages.
// sent_at is typed ISO string downstream, as supabase-js used to give it).
pg.types.setTypeParser(1114, (v) => v);
pg.types.setTypeParser(1184, (v) => v);
// 1700 = NUMERIC — a number is fine for the amounts and percentages here.
pg.types.setTypeParser(1700, (v) => Number(v));
let pool = null;
if (STUDIO_DATABASE_URL) {
    pool = new pg.Pool({
        connectionString: STUDIO_DATABASE_URL,
        max: 3, // the role's connection limit is 5; leave room for a psql session
        idleTimeoutMillis: 30_000,
        connectionTimeoutMillis: 10_000,
        ssl: {
            ca: SUPABASE_ROOT_CA,
            rejectUnauthorized: process.env.STUDIO_DATABASE_SSL_NO_VERIFY !== "1",
        },
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
