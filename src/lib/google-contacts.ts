/**
 * Google People API for the STUDIO's Google account (the one that owns the
 * "Haven clients" contacts), used by src/crons/google-contacts-sync.ts.
 *
 * Its own login and its own token file: `/authcontacts` in Madalena's DM writes
 * DATA_DIR/google-contacts-tokens.json, scope `contacts` only. It never reads
 * google-tokens.json — that one is Madalena's calendar token (`/auth`,
 * src/lib/calendar.ts), a different Google account. Same OAuth client
 * (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET), same copy-the-code flow.
 */

import fs from "node:fs";
import path from "node:path";
import { google, type people_v1 } from "googleapis";

import { log } from "./log.js";

const DATA_DIR = process.env.DATA_DIR ?? ".";
const TOKENS_PATH = path.join(DATA_DIR, "google-contacts-tokens.json");
const SCOPE = "https://www.googleapis.com/auth/contacts";

/** Pre-selected on Google's login page, so the wrong account is harder to pick. */
export const STUDIO_ACCOUNT = process.env.GOOGLE_CONTACTS_ACCOUNT ?? "yourhavenpilates@gmail.com";

const PERSON_FIELDS = "names,phoneNumbers,memberships,clientData,metadata";
// People API batch limits.
const GET_BATCH = 200;
const WRITE_BATCH = 200;
const DELETE_BATCH = 500;

let _oauthClient: ReturnType<typeof createOAuthClient> | null = null;

function createOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI ?? "http://localhost:3000",
  );
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
    log.error("google_contacts.save_tokens_failed", { err: String(err) });
  }
}

export function isAuthenticated(): boolean {
  return fs.existsSync(TOKENS_PATH);
}

export function getAuthUrl(): string {
  return createOAuthClient().generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: [SCOPE],
    login_hint: STUDIO_ACCOUNT,
  });
}

export async function exchangeCodeForToken(codeOrUrl: string): Promise<void> {
  let code = codeOrUrl.trim();
  // Accept full redirect URL or bare code
  try {
    const fromUrl = new URL(code).searchParams.get("code");
    if (fromUrl) code = fromUrl;
  } catch {
    // not a URL — use as-is
  }
  const { tokens } = await createOAuthClient().getToken(code);
  saveTokens(tokens as Record<string, unknown>);
  _oauthClient = null; // force recreation with new tokens
}

function api(): people_v1.People {
  const tokens = loadTokens();
  if (!tokens) throw new Error("google contacts: not authenticated (run /authcontacts)");
  if (!_oauthClient) {
    _oauthClient = createOAuthClient();
    _oauthClient.on("tokens", (newTokens) => {
      saveTokens({ ...(loadTokens() ?? {}), ...newTokens });
    });
  }
  _oauthClient.setCredentials(tokens);
  return google.people({ version: "v1", auth: _oauthClient });
}

/** True when Google refuses the stored login itself: expired or revoked, only a new /authcontacts fixes it. */
export function isAuthError(err: unknown): boolean {
  const e = err as { code?: number | string; status?: number; message?: string; response?: { data?: { error?: unknown } } };
  const oauthError = e?.response?.data?.error;
  return (
    oauthError === "invalid_grant" ||
    /invalid_grant|not authenticated/.test(String(e?.message ?? "")) ||
    Number(e?.code) === 401 ||
    e?.status === 401
  );
}

function isRetryable(err: unknown): boolean {
  const status = Number((err as { code?: number | string })?.code ?? (err as { status?: number })?.status);
  return status === 429 || (status >= 500 && status < 600);
}

/** 3 attempts on 429/5xx (2s → 8s): the People API's write quota is per minute. */
async function withRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const delays = [2000, 8000];
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= delays.length || !isRetryable(err)) throw err;
      log.warn("google_contacts.retry", { label, attempt: attempt + 1, err: String(err) });
      await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
    }
  }
}

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export interface ContactGroup {
  resourceName: string;
  name: string;
}

/** The account's own labels (not Google's system groups). */
export async function listUserGroups(): Promise<ContactGroup[]> {
  const people = api();
  const groups: ContactGroup[] = [];
  let pageToken: string | undefined;
  do {
    const res = await withRetry("groups.list", () =>
      people.contactGroups.list({ pageSize: 1000, pageToken, groupFields: "name,groupType" }),
    );
    for (const g of res.data.contactGroups ?? []) {
      if (g.groupType === "USER_CONTACT_GROUP" && g.resourceName && g.name) {
        groups.push({ resourceName: g.resourceName, name: g.name });
      }
    }
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);
  return groups;
}

export async function createGroup(name: string): Promise<ContactGroup> {
  const res = await withRetry("groups.create", () =>
    api().contactGroups.create({ requestBody: { contactGroup: { name } } }),
  );
  if (!res.data.resourceName) throw new Error(`google contacts: label "${name}" was not created`);
  return { resourceName: res.data.resourceName, name };
}

/** Every contact in one label — the only contacts this file ever reads. */
export async function listGroupContacts(groupResourceName: string): Promise<people_v1.Schema$Person[]> {
  const people = api();
  const head = await withRetry("groups.get", () =>
    people.contactGroups.get({ resourceName: groupResourceName, groupFields: "memberCount" }),
  );
  const memberCount = head.data.memberCount ?? 0;
  if (memberCount === 0) return [];
  const group = await withRetry("groups.get_members", () =>
    people.contactGroups.get({ resourceName: groupResourceName, maxMembers: memberCount, groupFields: "memberCount" }),
  );
  const names = group.data.memberResourceNames ?? [];
  if (names.length < memberCount) {
    // A short list would make the diff recreate people who are already there.
    throw new Error(`google contacts: label has ${memberCount} contacts but only ${names.length} were returned`);
  }

  const out: people_v1.Schema$Person[] = [];
  for (const batch of chunks(names, GET_BATCH)) {
    const res = await withRetry("people.get_batch", () =>
      people.people.getBatchGet({ resourceNames: batch, personFields: PERSON_FIELDS }),
    );
    for (const r of res.data.responses ?? []) if (r.person?.resourceName) out.push(r.person);
  }
  if (out.length < names.length) {
    throw new Error(`google contacts: ${names.length} contacts in the label but only ${out.length} could be read`);
  }
  return out;
}

export async function createContacts(persons: people_v1.Schema$Person[]): Promise<void> {
  for (const batch of chunks(persons, WRITE_BATCH)) {
    await withRetry("people.batch_create", () =>
      api().people.batchCreateContacts({
        requestBody: { contacts: batch.map((contactPerson) => ({ contactPerson })), readMask: "metadata" },
      }),
    );
  }
}

/** Each person needs its resourceName and etag; only `updateFields` are written. */
export async function updateContacts(persons: people_v1.Schema$Person[], updateFields: string): Promise<void> {
  for (const batch of chunks(persons, WRITE_BATCH)) {
    const contacts: Record<string, people_v1.Schema$Person> = {};
    for (const p of batch) contacts[p.resourceName as string] = p;
    await withRetry("people.batch_update", () =>
      api().people.batchUpdateContacts({ requestBody: { contacts, updateMask: updateFields, readMask: "metadata" } }),
    );
  }
}

export async function deleteContacts(resourceNames: string[]): Promise<void> {
  for (const batch of chunks(resourceNames, DELETE_BATCH)) {
    await withRetry("people.batch_delete", () =>
      api().people.batchDeleteContacts({ requestBody: { resourceNames: batch } }),
    );
  }
}
