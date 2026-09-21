/**
 * Gmail API wrapper for the competitor-intel pipeline — a separate Google
 * account (yourhavenpilates@gmail.com) from the one already authorized for
 * Google Calendar (see calendar.ts), so this keeps its own OAuth client and
 * token storage even though it reuses the same GOOGLE_CLIENT_ID/SECRET app.
 *
 * Scope is gmail.modify (not readonly): the tidy phase needs to add a label
 * and remove the INBOX label to archive.
 */

import fs from "node:fs";
import path from "node:path";
import { google } from "googleapis";
import { log } from "./log.js";

const DATA_DIR = process.env.DATA_DIR ?? ".";
const TOKENS_PATH = path.join(DATA_DIR, "gmail-competitor-tokens.json");

export interface GmailMessage {
  id: string;
  threadId: string;
  subject: string;
  fromName: string;
  fromEmail: string;
  date: string; // ISO, from the Date header when parseable, else received internalDate
  body: string; // decoded plain-text (falls back to a stripped text/html part)
  webLink: string;
  labelIds: string[];
}

let _oauthClient: ReturnType<typeof createOAuthClient> | null = null;
let _labelCache: { data: Map<string, string>; ts: number } = { data: new Map(), ts: 0 };
const LABEL_CACHE_TTL = 5 * 60 * 1000;

function createOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI ?? "http://localhost:3000",
  );
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

function loadTokens(): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(TOKENS_PATH, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function saveTokens(tokens: Record<string, unknown>): void {
  try {
    fs.mkdirSync(path.dirname(TOKENS_PATH), { recursive: true });
    fs.writeFileSync(TOKENS_PATH, JSON.stringify(tokens, null, 2));
  } catch (err) {
    log.error("gmail.save_tokens_failed", { err: String(err) });
  }
}

export function isAuthenticated(): boolean {
  if (process.env.GOOGLE_REFRESH_TOKEN_GMAIL_COMPETITOR) return true;
  return fs.existsSync(TOKENS_PATH);
}

export function getAuthUrl(): string {
  const client = createOAuthClient();
  return client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: ["https://www.googleapis.com/auth/gmail.modify"],
  });
}

export async function exchangeCodeForToken(codeOrUrl: string): Promise<void> {
  let code = codeOrUrl.trim();
  try {
    const url = new URL(code);
    const fromUrl = url.searchParams.get("code");
    if (fromUrl) code = fromUrl;
  } catch {
    // not a URL — use as-is
  }

  const client = createOAuthClient();
  const { tokens } = await client.getToken(code);
  saveTokens(tokens as Record<string, unknown>);
  _oauthClient = null;
  _labelCache = { data: new Map(), ts: 0 };
}

async function getAuthenticatedClient(): Promise<ReturnType<typeof createOAuthClient> | null> {
  const envToken = process.env.GOOGLE_REFRESH_TOKEN_GMAIL_COMPETITOR;
  if (envToken) {
    const client = getOAuthClient();
    client.setCredentials({ refresh_token: envToken });
    return client;
  }

  const tokens = loadTokens();
  if (!tokens) return null;

  const client = getOAuthClient();
  client.setCredentials(tokens);
  return client;
}

async function getGmailClient() {
  const auth = await getAuthenticatedClient();
  if (!auth) return null;
  return google.gmail({ version: "v1", auth });
}

async function getLabelMap(gmail: NonNullable<Awaited<ReturnType<typeof getGmailClient>>>): Promise<Map<string, string>> {
  const now = Date.now();
  if (_labelCache.data.size && now - _labelCache.ts < LABEL_CACHE_TTL) {
    return _labelCache.data;
  }
  const res = await gmail.users.labels.list({ userId: "me" });
  const map = new Map<string, string>();
  for (const l of res.data.labels ?? []) {
    if (l.name && l.id) map.set(l.name, l.id);
  }
  _labelCache = { data: map, ts: now };
  return map;
}

/** Returns the label id, or null if it doesn't exist. Never creates it. */
export async function findLabelByName(name: string): Promise<string | null> {
  const gmail = await getGmailClient();
  if (!gmail) return null;
  const map = await getLabelMap(gmail);
  return map.get(name) ?? null;
}

/** Returns the label id, creating the label if it doesn't exist yet. */
export async function getOrCreateLabel(name: string): Promise<string | null> {
  const gmail = await getGmailClient();
  if (!gmail) return null;
  const map = await getLabelMap(gmail);
  const existing = map.get(name);
  if (existing) return existing;

  const created = await gmail.users.labels.create({
    userId: "me",
    requestBody: { name, labelListVisibility: "labelShow", messageListVisibility: "show" },
  });
  const id = created.data.id;
  if (!id) return null;
  _labelCache.data.set(name, id);
  log.info("gmail.label_created", { name, id });
  return id;
}

function decodeBase64Url(data: string): string {
  return Buffer.from(data, "base64url").toString("utf8");
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

interface GmailPart {
  mimeType?: string | null;
  body?: { data?: string | null } | null;
  parts?: GmailPart[] | null;
}

function extractBody(payload: GmailPart | null | undefined): string {
  if (!payload) return "";

  // Direct body (simple, non-multipart messages).
  if (payload.body?.data && payload.mimeType?.startsWith("text/")) {
    const decoded = decodeBase64Url(payload.body.data);
    return payload.mimeType === "text/html" ? stripHtml(decoded) : decoded;
  }

  const parts = payload.parts ?? [];
  const plain = parts.find((p) => p.mimeType === "text/plain" && p.body?.data);
  if (plain?.body?.data) return decodeBase64Url(plain.body.data);

  const html = parts.find((p) => p.mimeType === "text/html" && p.body?.data);
  if (html?.body?.data) return stripHtml(decodeBase64Url(html.body.data));

  // Multipart/alternative or /mixed nested another level down (e.g. multipart/related).
  for (const p of parts) {
    if (p.parts) {
      const nested = extractBody(p);
      if (nested) return nested;
    }
  }
  return "";
}

function headerValue(headers: Array<{ name?: string | null; value?: string | null }> | undefined, name: string): string {
  return headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? "";
}

function parseFrom(fromHeader: string): { name: string; email: string } {
  const match = fromHeader.match(/^(.*?)\s*<(.+)>$/);
  const rawName = match?.[1];
  const rawEmail = match?.[2];
  if (rawEmail) {
    const name = rawName?.replace(/"/g, "").trim();
    return { name: name || rawEmail, email: rawEmail.trim().toLowerCase() };
  }
  return { name: fromHeader.trim(), email: fromHeader.trim().toLowerCase() };
}

async function fetchMessage(
  gmail: NonNullable<Awaited<ReturnType<typeof getGmailClient>>>,
  id: string,
): Promise<GmailMessage | null> {
  const res = await gmail.users.messages.get({ userId: "me", id, format: "full" });
  const msg = res.data;
  const headers = msg.payload?.headers ?? [];
  const from = parseFrom(headerValue(headers, "From"));
  const dateHeader = headerValue(headers, "Date");
  const parsedDate = dateHeader ? new Date(dateHeader) : null;
  const date =
    parsedDate && !Number.isNaN(parsedDate.getTime())
      ? parsedDate.toISOString()
      : new Date(Number(msg.internalDate ?? Date.now())).toISOString();

  return {
    id: msg.id ?? id,
    threadId: msg.threadId ?? "",
    subject: headerValue(headers, "Subject") || "(sem assunto)",
    fromName: from.name,
    fromEmail: from.email,
    date,
    body: extractBody(msg.payload),
    webLink: `https://mail.google.com/mail/u/0/#all/${msg.id ?? id}`,
    labelIds: msg.labelIds ?? [],
  };
}

/**
 * Messages currently in the Inbox from any of the given sender
 * addresses/domains. Used by the tidy phase — archived mail simply never
 * shows up here again, so no separate "already tidied" state is needed.
 */
export async function listInboxMessagesFromSenders(senders: string[]): Promise<GmailMessage[]> {
  if (senders.length === 0) return [];
  const gmail = await getGmailClient();
  if (!gmail) return [];

  const fromClause = senders.map((s) => `from:${s}`).join(" OR ");
  const q = `in:inbox (${fromClause})`;

  const ids: string[] = [];
  let pageToken: string | undefined;
  do {
    const res = await gmail.users.messages.list({ userId: "me", q, pageToken, maxResults: 100 });
    for (const m of res.data.messages ?? []) if (m.id) ids.push(m.id);
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);

  const messages = await Promise.all(ids.map((id) => fetchMessage(gmail, id)));
  return messages.filter((m): m is GmailMessage => m !== null);
}

/**
 * Messages carrying `labelName` but not `excludeLabelName` — the process
 * phase's "still needs extracting" query.
 */
export async function listMessagesByLabel(
  labelName: string,
  excludeLabelName?: string,
): Promise<GmailMessage[]> {
  const gmail = await getGmailClient();
  if (!gmail) return [];

  const q = excludeLabelName
    ? `label:"${labelName}" -label:"${excludeLabelName}"`
    : `label:"${labelName}"`;

  const ids: string[] = [];
  let pageToken: string | undefined;
  do {
    const res = await gmail.users.messages.list({ userId: "me", q, pageToken, maxResults: 100 });
    for (const m of res.data.messages ?? []) if (m.id) ids.push(m.id);
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);

  const messages = await Promise.all(ids.map((id) => fetchMessage(gmail, id)));
  return messages.filter((m): m is GmailMessage => m !== null);
}

/** Tags a message with `labelId` and removes it from the Inbox (archives it). */
export async function tagAndArchive(messageId: string, labelId: string): Promise<void> {
  const gmail = await getGmailClient();
  if (!gmail) throw new Error("gmail: not authenticated");
  await gmail.users.messages.modify({
    userId: "me",
    id: messageId,
    requestBody: { addLabelIds: [labelId], removeLabelIds: ["INBOX"] },
  });
}

/** Adds `labelId` to a message without touching its Inbox state. */
export async function applyLabel(messageId: string, labelId: string): Promise<void> {
  const gmail = await getGmailClient();
  if (!gmail) throw new Error("gmail: not authenticated");
  await gmail.users.messages.modify({
    userId: "me",
    id: messageId,
    requestBody: { addLabelIds: [labelId] },
  });
}
