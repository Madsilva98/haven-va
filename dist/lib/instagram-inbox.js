/**
 * Reads Mafalda's own Instagram inbox tables (inbox_contacts /
 * inbox_messages) in the studio project — NOT created by any haven-va
 * migration, they're owned by her separate tooling (the live webhook
 * receiver + the one-time "download your data" backfill). See
 * docs/knowledge-base for the full schema notes.
 *
 * Read over the bot's own Postgres connection (src/lib/studio-db.ts, role
 * haven_va, search_path va): va.inbox_contacts and va.inbox_messages are
 * read-only mirrors of Mafalda's tables (pulse_cases #24, live since
 * 2026-09-21). 471 Instagram contacts / 5,944 messages on that day.
 *
 * Used by src/crons/leads-instagram-scan.ts.
 */
import { normalizeText } from "./fuzzy-match.js";
import { isStudioDbAvailable, query } from "./studio-db.js";
// normalizeText handles case/diacritics but leaves punctuation alone —
// that's not enough here, since Instagram display names can have extra
// junk glued on (e.g. an email address someone pasted into their own
// name field: "susana.vie info@susanavie.com" for the founder's excluded
// "Susana Vie" — an exact-match check on that field missed her entirely,
// found in production 2026-09-21). Collapsing all punctuation to spaces
// and matching by substring instead catches this without needing every
// exact real-world variant hardcoded.
function normalizeForExclusionMatch(s) {
    return normalizeText(s)
        .replace(/[^a-z0-9]+/g, " ")
        .trim();
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
const EXCLUDED_INSTAGRAM_NAMES = [
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
].map(normalizeForExclusionMatch);
export function isExcludedInstagramContact(c) {
    const displayName = c.displayName ? normalizeForExclusionMatch(c.displayName) : null;
    const username = c.username ? normalizeForExclusionMatch(c.username) : null;
    return EXCLUDED_INSTAGRAM_NAMES.some((excluded) => (displayName !== null && displayName.includes(excluded)) || (username !== null && username.includes(excluded)));
}
/**
 * Pure — no I/O. Groups messages by contact_id and attaches them to their
 * contact row, in the order the rows were given (callers already sort
 * messages by sent_at at the query level). Exported for unit testing
 * without a Supabase call.
 */
export function groupMessagesByContact(contactRows, messageRows) {
    const messagesByContact = new Map();
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
export async function fetchInstagramContactsWithMessages() {
    if (!isStudioDbAvailable())
        return [];
    const [contactRows, messageRows] = await Promise.all([
        query(`select id, platform_user_id, display_name, username, message_count
         from inbox_contacts where platform = 'instagram'`),
        query(`select contact_id, direction, text, sent_at
         from inbox_messages where platform = 'instagram' order by sent_at asc`),
    ]);
    return groupMessagesByContact(contactRows, messageRows);
}
const DEFAULT_MAX_CHARS = 8000;
/**
 * True if the contact ever sent at least one message with text — as
 * opposed to a contact who exists in the table only because the STUDIO
 * cold-messaged them (e.g. an influencer/brand outreach campaign) and got
 * no reply. Those "out"-only threads still contain the studio's own
 * "queríamos explorar uma parceria" language, which fooled the classifier
 * into flagging them as a "parceiro" candidate (found in production
 * 2026-09-21, e.g. "Piiiton", zero inbound messages, only the studio's own
 * outreach) — a page should only ever get created from something the
 * CONTACT said, never from our own message being read back to us. Callers
 * must check this before classifying at all, not just before building the
 * transcript, since an out-only transcript is still non-empty text.
 */
export function hasInboundMessage(messages) {
    return messages.some((m) => m.direction === "in" && m.text);
}
/**
 * Chronological "Cliente:"/"Haven:" transcript for the classifier — both
 * directions, since a one-word reply from the client often only makes
 * sense next to what we said before it. Capped from the start (earliest
 * messages), matching the classifier's own truncation and because an
 * initial information request is usually near the start of a thread.
 */
export function buildTranscript(messages, maxChars = DEFAULT_MAX_CHARS) {
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
export function extractVolunteeredEmail(messages) {
    for (const m of messages) {
        if (m.direction !== "in" || !m.text)
            continue;
        const match = m.text.match(EMAIL_PATTERN);
        if (match)
            return match[0];
    }
    return null;
}
export function extractVolunteeredPhone(messages) {
    for (const m of messages) {
        if (m.direction !== "in" || !m.text)
            continue;
        const match = m.text.match(PHONE_PATTERN);
        if (match)
            return match[0].replace(/[\s-]/g, "");
    }
    return null;
}
