import fs from "node:fs";
import path from "node:path";
import { log } from "./log.js";
const DATA_DIR = process.env.DATA_DIR ?? ".";
const TOKENS_PATH = path.join(DATA_DIR, "outlook-tokens.json");
const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
const SCOPES = "offline_access Mail.Read Mail.Read.Shared";
let _cached = null;
function tenantId() {
    const id = process.env.MICROSOFT_TENANT_ID;
    if (!id)
        throw new Error("MICROSOFT_TENANT_ID not set");
    return id;
}
function clientId() {
    const id = process.env.MICROSOFT_CLIENT_ID;
    if (!id)
        throw new Error("MICROSOFT_CLIENT_ID not set");
    return id;
}
function clientSecret() {
    const s = process.env.MICROSOFT_CLIENT_SECRET;
    if (!s)
        throw new Error("MICROSOFT_CLIENT_SECRET not set");
    return s;
}
function redirectUri() {
    return process.env.MICROSOFT_REDIRECT_URI ?? "http://localhost:3000";
}
function loadTokens() {
    try {
        return JSON.parse(fs.readFileSync(TOKENS_PATH, "utf8"));
    }
    catch {
        return null;
    }
}
function saveTokens(tokens) {
    try {
        fs.mkdirSync(path.dirname(TOKENS_PATH), { recursive: true });
        fs.writeFileSync(TOKENS_PATH, JSON.stringify(tokens, null, 2));
        _cached = tokens;
    }
    catch (err) {
        log.error("outlook.save_tokens_failed", { err: String(err) });
    }
}
export function isAuthenticated() {
    if (process.env.MICROSOFT_REFRESH_TOKEN_MADALENA)
        return true;
    return fs.existsSync(TOKENS_PATH);
}
export function getAuthUrl() {
    const url = new URL(`https://login.microsoftonline.com/${tenantId()}/oauth2/v2.0/authorize`);
    url.searchParams.set("client_id", clientId());
    url.searchParams.set("response_type", "code");
    url.searchParams.set("redirect_uri", redirectUri());
    url.searchParams.set("response_mode", "query");
    url.searchParams.set("scope", SCOPES);
    return url.toString();
}
async function requestToken(body) {
    const res = await fetch(`https://login.microsoftonline.com/${tenantId()}/oauth2/v2.0/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
    });
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`outlook token request failed (${res.status}): ${text}`);
    }
    const data = (await res.json());
    if (!data.refresh_token) {
        throw new Error("Microsoft did not return a refresh_token — ensure offline_access scope was consented");
    }
    return {
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        expires_at: Date.now() + data.expires_in * 1000,
    };
}
export async function exchangeCodeForToken(codeOrUrl) {
    let code = codeOrUrl.trim();
    // Accept full redirect URL or bare code
    try {
        const url = new URL(code);
        const fromUrl = url.searchParams.get("code");
        if (fromUrl)
            code = fromUrl;
    }
    catch {
        // not a URL — use as-is
    }
    const body = new URLSearchParams({
        client_id: clientId(),
        client_secret: clientSecret(),
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri(),
        scope: SCOPES,
    });
    const tokens = await requestToken(body);
    saveTokens(tokens);
}
// Microsoft rotates refresh tokens on every use, unlike Google's, which stay
// valid indefinitely until revoked. So the env-var override is only a
// one-time bootstrap here: once we successfully refresh, the rotated token
// is persisted to the file and used from then on, so a long-running
// container doesn't get stuck on a stale env var after the first rotation
// invalidates it.
async function getAccessToken() {
    const now = Date.now();
    if (_cached && _cached.expires_at - now > 60_000) {
        return _cached.access_token;
    }
    const fileTokens = loadTokens();
    const refreshToken = fileTokens?.refresh_token ?? process.env.MICROSOFT_REFRESH_TOKEN_MADALENA;
    if (!refreshToken) {
        throw new Error("outlook not authenticated — run scripts/outlook-auth.mjs");
    }
    const body = new URLSearchParams({
        client_id: clientId(),
        client_secret: clientSecret(),
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        scope: SCOPES,
    });
    const tokens = await requestToken(body);
    saveTokens(tokens);
    return tokens.access_token;
}
const RETRY_DELAYS_MS = [500, 2000, 8000];
async function graphFetch(url, extraHeaders = {}, attempt = 1) {
    const accessToken = await getAccessToken();
    const res = await fetch(url, {
        headers: { Authorization: `Bearer ${accessToken}`, ...extraHeaders },
    });
    if ((res.status === 429 || res.status >= 500) && attempt <= RETRY_DELAYS_MS.length) {
        const retryAfter = Number(res.headers.get("retry-after"));
        const delayMs = Number.isFinite(retryAfter) && retryAfter > 0
            ? retryAfter * 1000
            : RETRY_DELAYS_MS[attempt - 1];
        log.warn("outlook.graph_retry", { url, status: res.status, attempt, delayMs });
        await new Promise((r) => setTimeout(r, delayMs));
        return graphFetch(url, extraHeaders, attempt + 1);
    }
    return res;
}
/** The authenticated ("me") account's own email address. */
export async function getMyEmail() {
    const res = await graphFetch(`${GRAPH_BASE}/me?$select=mail,userPrincipalName`);
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`outlook.getMyEmail failed (${res.status}): ${text}`);
    }
    const data = (await res.json());
    return data.mail ?? data.userPrincipalName ?? "";
}
/**
 * Lists messages for a mailbox ("me" for the authenticated account's own
 * inbox, or another address the authenticated account has Full Access
 * delegate permission to — see docs/knowledge-base/outlook-partnerships-sync.md).
 * Paginates through every page. Omitting `sinceISO` scans full history.
 */
export async function searchMailboxMessages(mailbox, opts = {}) {
    const base = mailbox === "me"
        ? `${GRAPH_BASE}/me/messages`
        : `${GRAPH_BASE}/users/${encodeURIComponent(mailbox)}/messages`;
    const params = new URLSearchParams({
        $select: "id,subject,from,toRecipients,receivedDateTime,bodyPreview,body,webLink",
        $orderby: "receivedDateTime desc",
        $top: "25",
    });
    if (opts.sinceISO) {
        params.set("$filter", `receivedDateTime ge ${opts.sinceISO}`);
    }
    // Ask Graph to convert the body to plain text server-side (default is
    // HTML) — keeps keyword matching simple and avoids fetching markup we'd
    // otherwise have to strip ourselves.
    const headers = { Prefer: 'outlook.body-content-type="text"' };
    let url = `${base}?${params.toString()}`;
    const messages = [];
    while (url) {
        const res = await graphFetch(url, headers);
        if (!res.ok) {
            const text = await res.text();
            throw new Error(`outlook.searchMailboxMessages failed for ${mailbox} (${res.status}): ${text}`);
        }
        const data = (await res.json());
        for (const m of data.value) {
            messages.push({
                id: m.id,
                mailbox,
                subject: m.subject ?? "",
                from: {
                    name: m.from?.emailAddress?.name ?? "",
                    email: m.from?.emailAddress?.address ?? "",
                },
                to: (m.toRecipients ?? []).map((r) => ({
                    name: r.emailAddress?.name ?? "",
                    email: r.emailAddress?.address ?? "",
                })),
                receivedDateTime: m.receivedDateTime,
                bodyPreview: m.bodyPreview ?? "",
                body: m.body?.content ?? m.bodyPreview ?? "",
                webLink: m.webLink ?? "",
            });
        }
        url = data["@odata.nextLink"];
    }
    log.info("outlook.mailbox_scanned", {
        mailbox,
        count: messages.length,
        since: opts.sinceISO ?? "all",
    });
    return messages;
}
