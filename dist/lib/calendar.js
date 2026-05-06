import fs from "node:fs";
import path from "node:path";
import { google } from "googleapis";
import { log } from "./log.js";
const DATA_DIR = process.env.DATA_DIR ?? ".";
const TOKENS_PATH = path.join(DATA_DIR, "google-tokens.json");
const CACHE_TTL = 5 * 60 * 1000; // 5 min
const CACHE_CAL_TTL = 24 * 60 * 60 * 1000; // 24h
let _oauthClient = null;
let _eventsCache = { data: [], ts: 0 };
let _calsCache = {
    data: [],
    ts: 0,
};
function createOAuthClient() {
    return new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, process.env.GOOGLE_REDIRECT_URI ?? "http://localhost:3000");
}
function getOAuthClient() {
    if (!_oauthClient) {
        _oauthClient = createOAuthClient();
        _oauthClient.on("tokens", (newTokens) => {
            const existing = loadTokens() ?? {};
            saveTokens({ ...existing, ...newTokens });
        });
    }
    return _oauthClient;
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
    }
    catch (err) {
        log.error("calendar.save_tokens_failed", { err: String(err) });
    }
}
export function isAuthenticated() {
    // Check env var first (for production override), then file
    if (process.env.GOOGLE_REFRESH_TOKEN_MADALENA)
        return true;
    return fs.existsSync(TOKENS_PATH);
}
export function getAuthUrl() {
    const client = createOAuthClient();
    return client.generateAuthUrl({
        access_type: "offline",
        prompt: "consent",
        scope: [
            "https://www.googleapis.com/auth/calendar.readonly",
            "https://www.googleapis.com/auth/calendar.events",
        ],
    });
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
    const client = createOAuthClient();
    const { tokens } = await client.getToken(code);
    saveTokens(tokens);
    _oauthClient = null; // force recreation with new tokens
    _eventsCache = { data: [], ts: 0 };
    _calsCache = { data: [], ts: 0 };
}
async function getAuthenticatedClient() {
    // Env var override: inject refresh token without a file
    const envToken = process.env.GOOGLE_REFRESH_TOKEN_MADALENA;
    if (envToken) {
        const client = getOAuthClient();
        client.setCredentials({ refresh_token: envToken });
        return client;
    }
    const tokens = loadTokens();
    if (!tokens)
        return null;
    const client = getOAuthClient();
    client.setCredentials(tokens);
    return client;
}
export async function listAllCalendars() {
    const now = Date.now();
    if (_calsCache.data.length && now - _calsCache.ts < CACHE_CAL_TTL) {
        return _calsCache.data;
    }
    const auth = await getAuthenticatedClient();
    if (!auth)
        return [];
    const cal = google.calendar({ version: "v3", auth });
    try {
        const res = await cal.calendarList.list();
        const items = (res.data.items ?? [])
            .filter((c) => c.id && c.summary)
            .map((c) => ({ id: c.id, summary: c.summary }));
        _calsCache = { data: items, ts: now };
        return items;
    }
    catch (err) {
        log.warn("calendar.list_calendars_failed", { err: String(err) });
        return [];
    }
}
function normalizeEvent(event, calendarId, calendarName) {
    const startRaw = event.start?.dateTime ?? event.start?.date ?? "";
    const endRaw = event.end?.dateTime ?? event.end?.date ?? "";
    const allDay = !event.start?.dateTime;
    return {
        id: event.id ?? "",
        title: event.summary ?? "(sem título)",
        start: new Date(startRaw),
        end: new Date(endRaw),
        calendarId,
        calendarName,
        allDay,
    };
}
export async function listEvents(days = 7) {
    const now = Date.now();
    if (_eventsCache.data.length && now - _eventsCache.ts < CACHE_TTL) {
        return _eventsCache.data;
    }
    const auth = await getAuthenticatedClient();
    if (!auth)
        return [];
    const cal = google.calendar({ version: "v3", auth });
    const calIds = (process.env.GOOGLE_CALENDAR_IDS ?? "primary")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    const timeMin = new Date().toISOString();
    const timeMax = new Date(now + days * 86_400_000).toISOString();
    const results = await Promise.all(calIds.map(async (calId) => {
        try {
            const calInfo = await cal.calendars.get({ calendarId: calId });
            const calName = calInfo.data.summary ?? calId;
            const res = await cal.events.list({
                calendarId: calId,
                timeMin,
                timeMax,
                singleEvents: true,
                orderBy: "startTime",
                maxResults: 50,
            });
            return (res.data.items ?? []).map((e) => normalizeEvent(e, calId, calName));
        }
        catch (err) {
            log.warn("calendar.fetch_calendar_failed", { calId, err: String(err) });
            return [];
        }
    }));
    const all = results
        .flat()
        .filter((e) => !Number.isNaN(e.start.getTime()))
        .sort((a, b) => a.start.getTime() - b.start.getTime());
    _eventsCache = { data: all, ts: now };
    return all;
}
export async function listEventsToday() {
    const events = await listEvents(1);
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayEnd = new Date(todayStart);
    todayEnd.setDate(todayEnd.getDate() + 1);
    return events.filter((e) => e.start >= todayStart && e.start < todayEnd);
}
export async function createEvent(params) {
    const auth = await getAuthenticatedClient();
    if (!auth)
        return null;
    const cal = google.calendar({ version: "v3", auth });
    const calId = params.calendarId ?? "primary";
    const res = await cal.events.insert({
        calendarId: calId,
        requestBody: {
            summary: params.title,
            description: params.description ?? "",
            start: { dateTime: params.start.toISOString() },
            end: { dateTime: params.end.toISOString() },
        },
    });
    _eventsCache = { data: [], ts: 0 }; // invalidate
    return normalizeEvent(res.data, calId, calId);
}
export function invalidateEventsCache() {
    _eventsCache = { data: [], ts: 0 };
}
