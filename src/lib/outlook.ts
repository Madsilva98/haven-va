import fs from "node:fs";
import path from "node:path";
import { log } from "./log.js";

const DATA_DIR = process.env.DATA_DIR ?? ".";
const TOKENS_PATH = path.join(DATA_DIR, "outlook-tokens.json");

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
// ReadWrite/Send (+ .Shared) are needed for the tidy-mailboxes cron (archive,
// forward) on top of the partnerships-sync's read-only Mail.Read(.Shared).
// A token issued before these were added won't have them — re-run
// scripts/outlook-auth.mjs after this scope list changes, see
// docs/knowledge-base/outlook-partnerships-sync.md.
const SCOPES =
  "offline_access Mail.Read Mail.Read.Shared Mail.ReadWrite Mail.ReadWrite.Shared Mail.Send Mail.Send.Shared";

interface StoredTokens {
  access_token: string;
  refresh_token: string;
  expires_at: number; // epoch ms
}

export interface OutlookMessage {
  id: string;
  mailbox: string;
  subject: string;
  from: { name: string; email: string };
  to: { name: string; email: string }[];
  receivedDateTime: string;
  bodyPreview: string;
  /** Full message body as plain text (requested via the outlook.body-content-type Prefer header). */
  body: string;
  webLink: string;
  hasAttachments: boolean;
  categories: string[];
  isRead: boolean;
  lastModifiedDateTime: string;
  conversationId: string;
  /** Only meaningful for Sent Items — when the message was actually sent. */
  sentDateTime: string;
  parentFolderId: string;
}

export interface OutlookAttachment {
  name: string;
  contentType: string;
  size: number;
}

let _cached: StoredTokens | null = null;

function tenantId(): string {
  const id = process.env.MICROSOFT_TENANT_ID;
  if (!id) throw new Error("MICROSOFT_TENANT_ID not set");
  return id;
}

function clientId(): string {
  const id = process.env.MICROSOFT_CLIENT_ID;
  if (!id) throw new Error("MICROSOFT_CLIENT_ID not set");
  return id;
}

function clientSecret(): string {
  const s = process.env.MICROSOFT_CLIENT_SECRET;
  if (!s) throw new Error("MICROSOFT_CLIENT_SECRET not set");
  return s;
}

function redirectUri(): string {
  return process.env.MICROSOFT_REDIRECT_URI ?? "http://localhost:3000";
}

function loadTokens(): StoredTokens | null {
  try {
    return JSON.parse(fs.readFileSync(TOKENS_PATH, "utf8")) as StoredTokens;
  } catch {
    return null;
  }
}

function saveTokens(tokens: StoredTokens): void {
  try {
    fs.mkdirSync(path.dirname(TOKENS_PATH), { recursive: true });
    fs.writeFileSync(TOKENS_PATH, JSON.stringify(tokens, null, 2));
    _cached = tokens;
  } catch (err) {
    log.error("outlook.save_tokens_failed", { err: String(err) });
  }
}

export function isAuthenticated(): boolean {
  if (process.env.MICROSOFT_REFRESH_TOKEN_MADALENA) return true;
  return fs.existsSync(TOKENS_PATH);
}

export function getAuthUrl(): string {
  const url = new URL(
    `https://login.microsoftonline.com/${tenantId()}/oauth2/v2.0/authorize`,
  );
  url.searchParams.set("client_id", clientId());
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", redirectUri());
  url.searchParams.set("response_mode", "query");
  url.searchParams.set("scope", SCOPES);
  return url.toString();
}

async function requestToken(body: URLSearchParams): Promise<StoredTokens> {
  const res = await fetch(
    `https://login.microsoftonline.com/${tenantId()}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    },
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`outlook token request failed (${res.status}): ${text}`);
  }
  const data = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
  };
  if (!data.refresh_token) {
    throw new Error(
      "Microsoft did not return a refresh_token — ensure offline_access scope was consented",
    );
  }
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Date.now() + data.expires_in * 1000,
  };
}

export async function exchangeCodeForToken(codeOrUrl: string): Promise<void> {
  let code = codeOrUrl.trim();
  // Accept full redirect URL or bare code
  try {
    const url = new URL(code);
    const fromUrl = url.searchParams.get("code");
    if (fromUrl) code = fromUrl;
  } catch {
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
export async function getAccessToken(): Promise<string> {
  const now = Date.now();
  if (_cached && _cached.expires_at - now > 60_000) {
    return _cached.access_token;
  }

  const fileTokens = loadTokens();
  const refreshToken =
    fileTokens?.refresh_token ?? process.env.MICROSOFT_REFRESH_TOKEN_MADALENA;
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

async function graphFetch(
  url: string,
  extraHeaders: Record<string, string> = {},
  attempt = 1,
): Promise<Response> {
  const accessToken = await getAccessToken();
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}`, ...extraHeaders },
  });
  if ((res.status === 429 || res.status >= 500) && attempt <= RETRY_DELAYS_MS.length) {
    const retryAfter = Number(res.headers.get("retry-after"));
    const delayMs =
      Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : RETRY_DELAYS_MS[attempt - 1];
    log.warn("outlook.graph_retry", { url, status: res.status, attempt, delayMs });
    await new Promise((r) => setTimeout(r, delayMs));
    return graphFetch(url, extraHeaders, attempt + 1);
  }
  return res;
}

interface GraphEmailAddress {
  emailAddress?: { name?: string | null; address?: string | null } | null;
}

interface GraphMessage {
  id: string;
  subject?: string | null;
  from?: GraphEmailAddress | null;
  toRecipients?: GraphEmailAddress[] | null;
  receivedDateTime: string;
  bodyPreview?: string | null;
  body?: { contentType?: string | null; content?: string | null } | null;
  webLink?: string | null;
  hasAttachments?: boolean | null;
  categories?: string[] | null;
  isRead?: boolean | null;
  lastModifiedDateTime?: string | null;
  conversationId?: string | null;
  sentDateTime?: string | null;
  parentFolderId?: string | null;
}

interface GraphMessagesPage {
  value: GraphMessage[];
  "@odata.nextLink"?: string;
}

const MESSAGE_SELECT =
  "id,subject,from,toRecipients,receivedDateTime,bodyPreview,body,webLink,hasAttachments,categories,isRead,lastModifiedDateTime,conversationId,sentDateTime,parentFolderId";

// Ask Graph to convert the body to plain text server-side (default is
// HTML) — keeps keyword matching simple and avoids fetching markup we'd
// otherwise have to strip ourselves.
const TEXT_BODY_HEADER = { Prefer: 'outlook.body-content-type="text"' };

function mailboxBase(mailbox: "me" | string): string {
  return mailbox === "me"
    ? `${GRAPH_BASE}/me`
    : `${GRAPH_BASE}/users/${encodeURIComponent(mailbox)}`;
}

function mapGraphMessage(m: GraphMessage, mailbox: string): OutlookMessage {
  return {
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
    hasAttachments: m.hasAttachments ?? false,
    categories: m.categories ?? [],
    // Defaults to false (treated as unread → skipped) rather than true if
    // Graph ever omits this field — matching this whole feature's fail
    // toward inaction, not toward a mutation.
    isRead: m.isRead ?? false,
    lastModifiedDateTime: m.lastModifiedDateTime ?? m.receivedDateTime,
    conversationId: m.conversationId ?? "",
    sentDateTime: m.sentDateTime ?? m.receivedDateTime,
    parentFolderId: m.parentFolderId ?? "",
  };
}

async function fetchAllMessages(
  startUrl: string,
  mailbox: string,
): Promise<OutlookMessage[]> {
  let url: string | undefined = startUrl;
  const messages: OutlookMessage[] = [];

  while (url) {
    const res: Response = await graphFetch(url, TEXT_BODY_HEADER);
    if (!res.ok) {
      const text = await res.text();
      throw new Error(
        `outlook.fetchAllMessages failed for ${mailbox} (${res.status}): ${text}`,
      );
    }
    const data = (await res.json()) as GraphMessagesPage;
    for (const m of data.value) messages.push(mapGraphMessage(m, mailbox));
    url = data["@odata.nextLink"];
  }
  return messages;
}

/** The authenticated ("me") account's own email address. */
export async function getMyEmail(): Promise<string> {
  const res = await graphFetch(`${GRAPH_BASE}/me?$select=mail,userPrincipalName`);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`outlook.getMyEmail failed (${res.status}): ${text}`);
  }
  const data = (await res.json()) as { mail?: string | null; userPrincipalName?: string | null };
  return data.mail ?? data.userPrincipalName ?? "";
}

/**
 * Resolves a well-known mail folder's real id for a mailbox (e.g.
 * "archive"). Non-fatal on failure — returns null, and the caller should
 * treat that as "couldn't determine, don't filter" rather than erroring
 * out the whole scan over one lookup.
 */
async function resolveFolderId(mailbox: "me" | string, wellKnownName: string): Promise<string | null> {
  try {
    const res = await graphFetch(`${mailboxBase(mailbox)}/mailFolders/${wellKnownName}?$select=id`);
    if (!res.ok) return null;
    const data = (await res.json()) as { id?: string };
    return data.id ?? null;
  } catch {
    return null;
  }
}

/**
 * Lists messages for a mailbox ("me" for the authenticated account's own
 * inbox, or another address the authenticated account has Full Access
 * delegate permission to — see docs/knowledge-base/outlook-partnerships-sync.md).
 * Paginates through every page. Omitting `sinceISO` scans full history.
 *
 * Deliberately scans the WHOLE mailbox (not just Inbox) via the root
 * `/messages` collection, so a partnership email filed into some other
 * folder still gets caught — that's an intentional design choice, not an
 * oversight, see docs/knowledge-base/outlook-partnerships-sync.md.
 *
 * Archive is the one folder explicitly excluded afterward. Confirmed for
 * real (2026-09-15): root `/messages` includes Archive contents for the
 * "me" mailbox (unlike shared mailboxes, where it's excluded) — so a
 * message already archived by an earlier apply run was still found by a
 * later scan and got forwarded a second time. Archive specifically means
 * "already handled by this pipeline or tidy-mailboxes", never "missed
 * detection surface", so excluding it loses nothing the broader-than-Inbox
 * scan was actually meant to catch.
 */
export async function searchMailboxMessages(
  mailbox: "me" | string,
  opts: { sinceISO?: string } = {},
): Promise<OutlookMessage[]> {
  const params = new URLSearchParams({
    $select: MESSAGE_SELECT,
    $orderby: "receivedDateTime desc",
    $top: "25",
  });
  if (opts.sinceISO) {
    params.set("$filter", `receivedDateTime ge ${opts.sinceISO}`);
  }

  const [messages, archiveFolderId] = await Promise.all([
    fetchAllMessages(`${mailboxBase(mailbox)}/messages?${params.toString()}`, mailbox),
    resolveFolderId(mailbox, "archive"),
  ]);

  const filtered = archiveFolderId
    ? messages.filter((m) => m.parentFolderId !== archiveFolderId)
    : messages;
  const excludedCount = messages.length - filtered.length;
  if (excludedCount > 0) {
    log.info("outlook.archived_messages_excluded", { mailbox, count: excludedCount });
  }

  log.info("outlook.mailbox_scanned", {
    mailbox,
    count: filtered.length,
    since: opts.sinceISO ?? "all",
  });
  return filtered;
}

/**
 * Lists messages currently sitting in a mailbox's Inbox folder (not the
 * whole mailbox) — used by the tidy-mailboxes cron, where "still in Inbox"
 * IS the to-do queue: archiving a message is what removes it, so there's
 * no separate checkpoint file to maintain.
 */
export async function listInboxMessages(mailbox: "me" | string): Promise<OutlookMessage[]> {
  const params = new URLSearchParams({
    $select: MESSAGE_SELECT,
    $orderby: "receivedDateTime desc",
    $top: "50",
  });
  return fetchAllMessages(
    `${mailboxBase(mailbox)}/mailFolders/inbox/messages?${params.toString()}`,
    mailbox,
  );
}

/**
 * Lists messages in a mailbox's Sent Items — used to tell whether the Haven
 * has already replied to a given conversation (see conversationId on
 * OutlookMessage). Reply-quoting means a customer's *next* inbound message
 * usually shows a prior reply's content anyway, but if they never write
 * back, the reply only ever exists here, never in the Inbox.
 */
export async function listSentMessages(mailbox: "me" | string): Promise<OutlookMessage[]> {
  const params = new URLSearchParams({
    $select: MESSAGE_SELECT,
    $orderby: "receivedDateTime desc",
    $top: "50",
  });
  return fetchAllMessages(
    `${mailboxBase(mailbox)}/mailFolders/sentitems/messages?${params.toString()}`,
    mailbox,
  );
}

interface GraphAttachment {
  name?: string | null;
  contentType?: string | null;
  size?: number | null;
}

/** Attachment metadata only (name/type/size) — never fetches file content. */
export async function getMessageAttachments(
  mailbox: "me" | string,
  messageId: string,
): Promise<OutlookAttachment[]> {
  const url = `${mailboxBase(mailbox)}/messages/${encodeURIComponent(messageId)}/attachments?$select=name,contentType,size`;
  const res = await graphFetch(url);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`outlook.getMessageAttachments failed (${res.status}): ${text}`);
  }
  const data = (await res.json()) as { value: GraphAttachment[] };
  return data.value.map((a) => ({
    name: a.name ?? "",
    contentType: a.contentType ?? "",
    size: a.size ?? 0,
  }));
}

/**
 * Replaces a message's categories with the given list — pass the full
 * desired set (merge with the message's existing `categories` yourself
 * first if you need to preserve any), since Graph's PATCH overwrites the
 * whole collection rather than appending to it.
 */
export async function setMessageCategories(
  mailbox: "me" | string,
  messageId: string,
  categories: string[],
): Promise<void> {
  const url = `${mailboxBase(mailbox)}/messages/${encodeURIComponent(messageId)}`;
  const res = await fetch(url, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${await getAccessToken()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ categories }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`outlook.setMessageCategories failed (${res.status}): ${text}`);
  }
}

/**
 * Moves a message to the mailbox's Archive folder. Not retried on failure
 * (unlike graphFetch's GET helper) — a failed move should surface, not
 * silently retry a mutating call.
 */
export async function archiveMessage(mailbox: "me" | string, messageId: string): Promise<void> {
  const url = `${mailboxBase(mailbox)}/messages/${encodeURIComponent(messageId)}/move`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${await getAccessToken()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ destinationId: "archive" }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`outlook.archiveMessage failed (${res.status}): ${text}`);
  }
  log.info("outlook.message_archived", { mailbox, messageId });
}

/** Forwards a message as-is (with attachments) to the given recipient(s). */
export async function forwardMessage(
  mailbox: "me" | string,
  messageId: string,
  toEmails: string[],
  comment = "",
): Promise<void> {
  const url = `${mailboxBase(mailbox)}/messages/${encodeURIComponent(messageId)}/forward`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${await getAccessToken()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      comment,
      toRecipients: toEmails.map((address) => ({ emailAddress: { address } })),
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`outlook.forwardMessage failed (${res.status}): ${text}`);
  }
  log.info("outlook.message_forwarded", { mailbox, messageId, to: toEmails });
}
