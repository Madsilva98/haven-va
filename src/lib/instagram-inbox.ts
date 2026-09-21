/**
 * Reads Mafalda's own Instagram inbox tables (public.inbox_contacts /
 * public.inbox_messages) in the same Studio Supabase project haven-va
 * already reads from elsewhere — those tables are NOT created by any
 * haven-va migration, they're owned by her separate tooling (the live
 * webhook receiver + the one-time "download your data" backfill). See
 * docs/knowledge-base for the full schema notes.
 *
 * Used by src/crons/leads-instagram-scan.ts.
 */

import { normalizeText } from "./fuzzy-match.js";
import { fetchAllPages, studioSupabase } from "./studio-supabase.js";

export interface InstagramContact {
  id: string; // inbox_contacts.id (uuid) — stable, used as the checkpoint key
  platformUserId: string;
  displayName: string | null;
  username: string | null;
  messageCount: number;
}

export interface InstagramTranscriptMessage {
  direction: "in" | "out";
  text: string | null;
  sentAt: string; // ISO
}

export interface InstagramContactWithMessages extends InstagramContact {
  messages: InstagramTranscriptMessage[]; // ascending sentAt
}

/**
 * Known non-leads: not just staff/founder personal accounts, but also
 * peer/business contacts (fellow instructors, wellness businesses) who DM
 * the studio for networking rather than as a prospective client. Founder's
 * list, 2026-09-21 — she said there may be more later, which is exactly
 * what scripts/dry-run-instagram-leads.mjs's review step is for. The list
 * mixes what look like display names and @handles, so we normalize and
 * check both fields rather than trying to guess which is which.
 */
const EXCLUDED_INSTAGRAM_NAMES = new Set(
  [
    "Madalena Marques da Silva",
    "Mafalda Saudade",
    "Natacha McGlinchey",
    "Mari Jegundo",
    "Susana Vie",
    "Maria Trigueiro",
    "Helena Estrela",
    "Catia Pilates Core",
    "Rafaela Moutinho",
    "Move with Ana",
    "Beatriz Rogerio",
    "Sabine",
    "maryintheskyy",
    "mariana.fisiotintima",
    "Ana Vieira",
  ].map(normalizeText),
);

export function isExcludedInstagramContact(
  c: Pick<InstagramContact, "displayName" | "username">,
): boolean {
  const displayName = c.displayName ? normalizeText(c.displayName) : null;
  const username = c.username ? normalizeText(c.username) : null;
  return (
    (displayName !== null && EXCLUDED_INSTAGRAM_NAMES.has(displayName)) ||
    (username !== null && EXCLUDED_INSTAGRAM_NAMES.has(username))
  );
}

interface InboxContactRow {
  id: string;
  platform_user_id: string;
  display_name: string | null;
  username: string | null;
  message_count: number;
}

interface InboxMessageRow {
  contact_id: string;
  direction: "in" | "out";
  text: string | null;
  sent_at: string;
}

/**
 * Pure — no I/O. Groups messages by contact_id and attaches them to their
 * contact row, in the order the rows were given (callers already sort
 * messages by sent_at at the query level). Exported for unit testing
 * without a Supabase call.
 */
export function groupMessagesByContact(
  contactRows: InboxContactRow[],
  messageRows: InboxMessageRow[],
): InstagramContactWithMessages[] {
  const messagesByContact = new Map<string, InstagramTranscriptMessage[]>();
  for (const row of messageRows) {
    const list = messagesByContact.get(row.contact_id) ?? [];
    list.push({ direction: row.direction, text: row.text, sentAt: row.sent_at });
    messagesByContact.set(row.contact_id, list);
  }

  return contactRows.map((row) => ({
    id: row.id,
    platformUserId: row.platform_user_id,
    displayName: row.display_name,
    username: row.username,
    messageCount: row.message_count,
    messages: messagesByContact.get(row.id) ?? [],
  }));
}

/**
 * All Instagram contacts + their messages, grouped client-side. 469
 * contacts / 5,945 messages total (both platforms) is small enough to
 * pull whole in one run — same "small enough to fetch whole" reasoning
 * src/lib/leads.ts already documents for kenko_customers.
 */
export async function fetchInstagramContactsWithMessages(): Promise<InstagramContactWithMessages[]> {
  if (!studioSupabase) return [];

  const [contactRows, messageRows] = await Promise.all([
    fetchAllPages<InboxContactRow>((from, to) =>
      studioSupabase!
        .from("inbox_contacts")
        .select("id, platform_user_id, display_name, username, message_count")
        .eq("platform", "instagram")
        .range(from, to),
    ),
    fetchAllPages<InboxMessageRow>((from, to) =>
      studioSupabase!
        .from("inbox_messages")
        .select("contact_id, direction, text, sent_at")
        .eq("platform", "instagram")
        .order("sent_at", { ascending: true })
        .range(from, to),
    ),
  ]);

  return groupMessagesByContact(contactRows, messageRows);
}

const DEFAULT_MAX_CHARS = 8000;

/**
 * Chronological "Cliente:"/"Haven:" transcript for the classifier — both
 * directions, since a one-word reply from the client often only makes
 * sense next to what we said before it. Capped from the start (earliest
 * messages), matching the classifier's own truncation and because an
 * initial information request is usually near the start of a thread.
 */
export function buildTranscript(
  messages: InstagramTranscriptMessage[],
  maxChars: number = DEFAULT_MAX_CHARS,
): string {
  const lines = messages
    .filter((m) => m.text)
    .map((m) => `${m.direction === "in" ? "Cliente" : "Haven"}: ${m.text}`);
  return lines.join("\n").slice(0, maxChars);
}

const EMAIL_PATTERN = /[\w.+-]+@[\w-]+\.[\w.-]+/;
// A run of 9+ digits (allowing spaces/dashes/an optional leading +),
// loosely matching a PT mobile/landline number (9 digits) volunteered in
// free text.
const PHONE_PATTERN = /(?:\+?\d[\d\s-]{7,}\d)/;

/** Only "in" messages — never mistake our own contact details for theirs. */
export function extractVolunteeredEmail(messages: InstagramTranscriptMessage[]): string | null {
  for (const m of messages) {
    if (m.direction !== "in" || !m.text) continue;
    const match = m.text.match(EMAIL_PATTERN);
    if (match) return match[0];
  }
  return null;
}

export function extractVolunteeredPhone(messages: InstagramTranscriptMessage[]): string | null {
  for (const m of messages) {
    if (m.direction !== "in" || !m.text) continue;
    const match = m.text.match(PHONE_PATTERN);
    if (match) return match[0].replace(/[\s-]/g, "");
  }
  return null;
}
