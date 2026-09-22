/**
 * Email/domain identity matching against an existing Partner or Influencer
 * Pipeline contact list — promoted out of scripts/scan-outlook-partnerships.mjs
 * (2026-09-21) so both that manual audit script and the new automated
 * src/crons/sync-partnerships.ts cron share one implementation instead of
 * two copies drifting apart. Pure — no I/O, no Notion/Outlook calls.
 *
 * Independent of keyword matching: a message from (or, when the Haven
 * sent it, addressed to) an address already on file for an existing
 * contact is a strong identity signal — catches ongoing correspondence
 * that never happens to use a partnership/influencer-sounding word.
 */

const COMBINING_MARKS_RE = new RegExp(`[${String.fromCodePoint(0x0300)}-${String.fromCodePoint(0x036f)}]`, "g");

function foldAccents(s: string): string {
  return s.normalize("NFD").replace(COMBINING_MARKS_RE, "");
}

export function normalize(s: string): string {
  return foldAccents(s).toLowerCase();
}

export function domainOf(email: string): string {
  return (email.split("@")[1] ?? "").toLowerCase();
}

function domainToName(email: string): string {
  const domain = domainOf(email);
  const base = domain.split(".")[0] ?? domain;
  return base
    .split(/[-_.]/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(" ");
}

export interface EmailParty {
  name: string;
  email: string;
}

function nameFrom(party: EmailParty): string {
  const name = (party.name ?? "").trim();
  if (name) return name;
  if (party.email) return domainToName(party.email);
  return "(desconhecido)";
}

/**
 * When the Haven itself sent the message (sender's domain is one of our
 * own mailboxes), the real contact is the external recipient, not the
 * sender — e.g. a reply from partners@thehavenpilates.pt to an external
 * partner. Returns both name and email together so downstream code (the
 * Notion "Email" property) uses the same party the name was guessed from.
 *
 * Returns null when the Haven sent the message AND no external recipient
 * was found — i.e. there is genuinely no external party to name a page
 * after, not just an unclear one. Falling back to the sender's own name in
 * this case (the original behavior, until 2026-09-22) looked safe for a
 * generic shared mailbox ("Geral"/"The Haven" — an obviously-wrong guess a
 * human reviewer would dismiss on sight) but was confirmed wrong for real
 * once a founder's own personal mailbox is the sender: an internal
 * "FW: ..." forward from Madalena to the rest of the team produced
 * "Madalena Marques Da Silva" as the guessed partner name — a real,
 * plausible-looking person's name, not an obvious red flag, that a fully
 * unattended cron (src/crons/sync-partnerships.ts) would have silently
 * created a Partner/Influencer Pipeline page under. Every caller must skip
 * rather than guess on null — see that cron's handling.
 */
export function guessExternalParty(
  from: EmailParty,
  to: EmailParty[],
  ownDomains: Set<string>,
): { name: string; email: string } | null {
  const senderIsOwn = from.email && ownDomains.has(domainOf(from.email));
  if (senderIsOwn) {
    const externalRecipient = (to ?? []).find((r) => r.email && !ownDomains.has(domainOf(r.email)));
    if (externalRecipient) {
      return { name: nameFrom(externalRecipient), email: externalRecipient.email ?? "" };
    }
    return null;
  }
  return { name: nameFrom(from), email: from.email ?? "" };
}

// Domains never safe to treat as "this whole domain is one contact" —
// shared by many unrelated people. Exact-email matching still applies to
// these (the exact same icloud.com address emailing again is still a real
// match), only the broader "anyone @domain" inference is excluded.
const PUBLIC_EMAIL_DOMAINS = new Set([
  "gmail.com", "hotmail.com", "outlook.com", "live.com", "icloud.com",
  "me.com", "yahoo.com", "aol.com", "protonmail.com", "proton.me",
  "sapo.pt", "gmx.com", "msn.com",
]);

export interface KnownContact {
  id: string;
  name: string;
  email: string | null;
}

export interface ContactLookups {
  emailToContact: Map<string, KnownContact>;
  domainToContact: Map<string, KnownContact>;
}

/**
 * Builds the two lookup tables used to identify a message as "known
 * contact" independent of keywords. Domain-level matching is opt-in per
 * domain: skipped entirely for public providers (PUBLIC_EMAIL_DOMAINS),
 * for any domain shared by more than one contact (ambiguous — falls back
 * to keyword+fuzzy matching instead of guessing which one), and —
 * critically — for the Haven's OWN domains. A contact's stored Email
 * property is human/LLM-entered and can be wrong (confirmed for real:
 * "GetYourGuide"'s Email was mistakenly set to a founder's own
 * @thehavenpilates.pt address during an earlier apply run) — without this
 * exclusion, every internal email involving that address would wrongly
 * match that contact. A real contact is never on the Haven's own domain,
 * so this is a safe blanket exclusion, not just a fix for one bad row.
 */
export function buildContactLookups(contacts: KnownContact[], ownDomains: Set<string>): ContactLookups {
  const emailToContact = new Map<string, KnownContact>();
  const domainCounts = new Map<string, KnownContact[]>();
  for (const c of contacts) {
    if (!c.email) continue;
    const email = c.email.trim().toLowerCase();
    if (!email) continue;
    const domain = domainOf(email);
    if (ownDomains.has(domain)) continue;
    emailToContact.set(email, c);
    if (!domain || PUBLIC_EMAIL_DOMAINS.has(domain)) continue;
    domainCounts.set(domain, (domainCounts.get(domain) ?? []).concat(c));
  }
  const domainToContact = new Map<string, KnownContact>();
  for (const [domain, owners] of domainCounts) {
    if (owners.length === 1) domainToContact.set(domain, owners[0]!);
  }
  return { emailToContact, domainToContact };
}

export type MatchBasis = "exact_email" | "domain";

export interface KnownContactMatch {
  contact: KnownContact;
  matchBasis: MatchBasis;
}

function lookupContact(email: string | undefined, lookups: ContactLookups): KnownContactMatch | null {
  if (!email) return null;
  const lower = email.trim().toLowerCase();
  const exact = lookups.emailToContact.get(lower);
  if (exact) return { contact: exact, matchBasis: "exact_email" };
  const byDomain = lookups.domainToContact.get(domainOf(lower));
  if (byDomain) return { contact: byDomain, matchBasis: "domain" };
  return null;
}

/**
 * matchBasis matters downstream: an EXACT email match is the literal same
 * person emailing again — certain. A DOMAIN match only proves "same
 * organization", never "same initiative" — confirmed wrong for real
 * (76256@novasbe.pt, a student address, domain-matched to the existing
 * "Nova SBE (Well-Being)" partner for an unrelated pitch, "Nova Thirst
 * Project" — a different real-world partnership, not the same one). A
 * large organization can run many unrelated things under one domain, so
 * domain matches still need a "does this actually belong here" judgment
 * call downstream, never an automatic identity resolution.
 */
export function matchKnownContact(
  from: EmailParty,
  to: EmailParty[],
  ownDomains: Set<string>,
  lookups: ContactLookups,
): KnownContactMatch | null {
  const direct = lookupContact(from.email, lookups);
  if (direct) return direct;
  const senderIsOwn = from.email && ownDomains.has(domainOf(from.email));
  if (senderIsOwn) {
    for (const recipient of to ?? []) {
      const match = lookupContact(recipient.email, lookups);
      if (match) return match;
    }
  }
  return null;
}
