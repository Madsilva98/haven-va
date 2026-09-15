/**
 * Read-only scan of configured Outlook mailboxes for partnership mentions.
 * Writes a local JSON report — never touches Notion. Review the report,
 * then hand approved decisions to scripts/apply-outlook-findings.mjs.
 *
 * Usage:
 *   npm run build
 *   node --env-file=.env.local scripts/scan-outlook-partnerships.mjs [--since=YYYY-MM-DD] [--mailbox=addr ...] [--out=path]
 *
 * Omitting --since scans full mailbox history. --mailbox may be repeated;
 * defaults to "me" plus every address in OUTLOOK_MAILBOXES.
 *
 * See docs/knowledge-base/outlook-partnerships-sync.md.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import * as outlook from "../dist/lib/outlook.js";
import * as notion from "../dist/notion.js";

const DEFAULT_KEYWORDS = [
  "parceria", "parcerias", "parceiro", "parceira",
  "colaboração", "colaborar",
  "patrocínio", "patrocinar",
  "acordo comercial",
  "partnership", "partner", "collaboration", "sponsorship", "collab",
];

// Domains never safe to treat as "this whole domain is one partner" — shared
// by many unrelated people. Exact-email matching still applies to these
// (e.g. the exact same icloud.com address emailing again is still a real
// match), only the broader "anyone @domain" inference is excluded.
const PUBLIC_EMAIL_DOMAINS = new Set([
  "gmail.com", "hotmail.com", "outlook.com", "live.com", "icloud.com",
  "me.com", "yahoo.com", "aol.com", "protonmail.com", "proton.me",
  "sapo.pt", "gmx.com", "msn.com",
]);

function parseArgs(argv) {
  const out = { since: undefined, mailboxes: [], out: undefined };
  for (const arg of argv) {
    if (arg.startsWith("--since=")) out.since = arg.slice("--since=".length);
    else if (arg.startsWith("--mailbox=")) out.mailboxes.push(arg.slice("--mailbox=".length));
    else if (arg.startsWith("--out=")) out.out = arg.slice("--out=".length);
  }
  return out;
}

const COMBINING_MARKS_RE = new RegExp(
  `[${String.fromCodePoint(0x0300)}-${String.fromCodePoint(0x036f)}]`,
  "g",
);

function foldAccents(s) {
  return s.normalize("NFD").replace(COMBINING_MARKS_RE, "");
}

function normalize(s) {
  return foldAccents(s).toLowerCase();
}

function domainOf(email) {
  return (email.split("@")[1] ?? "").toLowerCase();
}

function domainToName(email) {
  const domain = domainOf(email);
  const base = domain.split(".")[0] ?? domain;
  return base
    .split(/[-_.]/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ");
}

function nameFrom(party) {
  const name = (party.name ?? "").trim();
  if (name) return name;
  if (party.email) return domainToName(party.email);
  return "(desconhecido)";
}

// When the Haven itself sent the message (sender's domain is one of our own
// mailboxes), the real partner is the external recipient, not the sender —
// e.g. a reply from partners@thehavenpilates.pt to an external partner.
// Returns both name and email together so downstream code (the Notion
// "Email" property) uses the same party the name was guessed from.
function guessExternalParty(from, to, ownDomains) {
  const senderIsOwn = from.email && ownDomains.has(domainOf(from.email));
  if (senderIsOwn) {
    const externalRecipient = (to ?? []).find((r) => r.email && !ownDomains.has(domainOf(r.email)));
    if (externalRecipient) {
      return { name: nameFrom(externalRecipient), email: externalRecipient.email ?? "" };
    }
  }
  return { name: nameFrom(from), email: from.email ?? "" };
}

// Builds the two lookup tables used to identify a message as "known
// contact" independent of keywords. Domain-level matching is opt-in per
// domain: skipped entirely for public providers (PUBLIC_EMAIL_DOMAINS), for
// any domain shared by more than one partner page (ambiguous — falls back
// to keyword+fuzzy matching instead of guessing which one), and — critically
// — for the Haven's OWN domains. A partner's stored Email property is
// human-entered and can be wrong (confirmed for real: "GetYourGuide"'s
// Email was mistakenly set to a founder's own @thehavenpilates.pt address
// during an earlier apply run) — without this exclusion, every internal
// email involving that address would wrongly match that partner. A real
// partner contact is never on the Haven's own domain, so this is a safe
// blanket exclusion, not just a fix for this one bad row.
function buildContactLookups(contacts, ownDomains) {
  const emailToContact = new Map();
  const domainCounts = new Map();
  for (const c of contacts) {
    if (!c.email) continue;
    const email = c.email.trim().toLowerCase();
    if (!email) continue;
    const domain = domainOf(email);
    if (ownDomains.has(domain)) {
      console.log(`  (ignoring "${c.name}"'s stored Email "${email}" — it's one of the Haven's own domains, likely bad data)`);
      continue;
    }
    emailToContact.set(email, c);
    if (!domain || PUBLIC_EMAIL_DOMAINS.has(domain)) continue;
    domainCounts.set(domain, (domainCounts.get(domain) ?? []).concat(c));
  }
  const domainToContact = new Map();
  for (const [domain, owners] of domainCounts) {
    if (owners.length === 1) {
      domainToContact.set(domain, owners[0]);
    } else {
      console.log(`  (skipping domain match for ${domain} — shared by ${owners.map((o) => o.name).join(", ")})`);
    }
  }
  return { emailToContact, domainToContact };
}

function lookupContact(email, emailToContact, domainToContact) {
  if (!email) return null;
  const lower = email.trim().toLowerCase();
  const exact = emailToContact.get(lower);
  if (exact) return { contact: exact, matchBasis: "exact_email" };
  const byDomain = domainToContact.get(domainOf(lower));
  if (byDomain) return { contact: byDomain, matchBasis: "domain" };
  return null;
}

// Independent of keyword matching: a message from (or, when the Haven sent
// it, addressed to) an address already on file for an existing partner is a
// strong identity signal — catches ongoing correspondence that never
// happens to use a partnership-sounding word ("posso mudar a call para
// 5ª feira?"), which the keyword scan alone would silently miss.
//
// Returns { contact, matchBasis } or null. matchBasis matters downstream:
// an EXACT email match is the literal same person emailing again — certain.
// A DOMAIN match only proves "same organization", never "same initiative" —
// confirmed wrong for real (76256@novasbe.pt, a student address, domain-
// matched to the existing "Nova SBE (Well-Being)" partner for an unrelated
// pitch, "Nova Thirst Project" — a different real-world partnership, not
// the same one). A large organization can run many unrelated things under
// one domain, so domain matches still need a human "does this actually
// belong on that page" judgment call — see the sync-partnerships skill.
function matchKnownContact(msg, ownDomains, emailToContact, domainToContact) {
  const direct = lookupContact(msg.from.email, emailToContact, domainToContact);
  if (direct) return direct;
  const senderIsOwn = msg.from.email && ownDomains.has(domainOf(msg.from.email));
  if (senderIsOwn) {
    for (const recipient of msg.to ?? []) {
      const match = lookupContact(recipient.email, emailToContact, domainToContact);
      if (match) return match;
    }
  }
  return null;
}

function findingId(mailbox, messageId) {
  return crypto.createHash("sha256").update(`${mailbox}:${messageId}`).digest("hex").slice(0, 12);
}

// Pulls a window of text around where a keyword actually matched, rather
// than always showing the opening lines (which are often just a greeting
// or company intro, not the part that mentions the partnership). `idx` is
// an offset into `foldedText`; since accent-folding can shift length by a
// few characters, generous padding absorbs the drift when slicing `rawText`.
function extractSnippet(rawText, foldedText, matchedKeywords) {
  for (const kw of matchedKeywords) {
    const idx = foldedText.indexOf(kw);
    if (idx === -1) continue;
    const start = Math.max(0, idx - 100);
    const end = Math.min(rawText.length, idx + kw.length + 250);
    const excerpt = rawText.slice(start, end).trim();
    if (excerpt) return (start > 0 ? "… " : "") + excerpt + (end < rawText.length ? " …" : "");
  }
  return rawText.slice(0, 300).trim();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  await notion.initialize();

  const configuredMailboxes = (process.env.OUTLOOK_MAILBOXES ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const mailboxes = args.mailboxes.length > 0 ? args.mailboxes : ["me", ...configuredMailboxes];

  const myEmail = await outlook.getMyEmail();
  const ownDomains = new Set(
    [domainOf(myEmail), ...configuredMailboxes.map(domainOf)].filter(Boolean),
  );

  const extraKeywords = (process.env.OUTLOOK_PARTNERSHIP_KEYWORDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const keywords = [...DEFAULT_KEYWORDS, ...extraKeywords].map(normalize);

  const allContacts = await notion.getAllPartnerContacts();
  const { emailToContact, domainToContact } = buildContactLookups(allContacts, ownDomains);
  console.log(`Known partner contacts: ${emailToContact.size} email(s), ${domainToContact.size} domain(s)`);

  const sinceISO = args.since ? new Date(`${args.since}T00:00:00.000Z`).toISOString() : undefined;
  const scannedAt = new Date().toISOString();

  console.log(`Scanning ${mailboxes.length} mailbox(es), since=${sinceISO ?? "(full history)"}`);
  console.log(`Mailboxes: ${mailboxes.join(", ")}`);
  console.log(`Keywords: ${keywords.join(", ")}\n`);

  const newFindings = [];
  const possibleMatchFindings = [];
  const knownContactFindings = [];
  const counts = {};

  for (const mailbox of mailboxes) {
    let messages;
    try {
      messages = await outlook.searchMailboxMessages(mailbox, { sinceISO });
    } catch (err) {
      console.error(`  ✗ ${mailbox}: ${err.message}`);
      counts[mailbox] = { scanned: 0, matched: 0, error: err.message };
      continue;
    }

    let matched = 0;
    let knownContactCount = 0;
    for (const msg of messages) {
      const rawText = `${msg.subject}\n${msg.body}`;
      const haystack = normalize(rawText);
      const matchedKeywords = keywords.filter((kw) => haystack.includes(kw));

      const knownContact = matchKnownContact(msg, ownDomains, emailToContact, domainToContact);
      if (!knownContact && matchedKeywords.length === 0) continue;
      matched++;

      const baseFinding = {
        findingId: findingId(mailbox, msg.id),
        messageId: msg.id,
        mailbox,
        from: msg.from,
        to: msg.to,
        subject: msg.subject,
        receivedDate: msg.receivedDateTime,
        snippet: extractSnippet(rawText, haystack, matchedKeywords),
        // Full body kept alongside the snippet — the signer, next step, and
        // deal context needed for review are often outside the matched
        // keyword's immediate vicinity (e.g. in a sign-off further down).
        body: msg.body,
        matchedKeywords,
        webLink: msg.webLink,
      };

      if (knownContact) {
        knownContactCount++;
        const { contact, matchBasis } = knownContact;
        knownContactFindings.push({
          ...baseFinding,
          matchType: "known_contact",
          matchBasis,
          guessedPartnerName: contact.name,
          guessedPartnerEmail: contact.email,
          matchedPage: { id: contact.id, title: contact.name },
        });
        continue;
      }

      const externalParty = guessExternalParty(msg.from, msg.to, ownDomains);
      const existing = await notion.findPageInDb("partners", externalParty.name);
      const finding = {
        ...baseFinding,
        matchType: "keyword",
        guessedPartnerName: externalParty.name,
        guessedPartnerEmail: externalParty.email,
      };

      if (existing) {
        possibleMatchFindings.push({ ...finding, matchedPage: existing });
      } else {
        newFindings.push(finding);
      }
    }

    counts[mailbox] = { scanned: messages.length, matched, knownContact: knownContactCount };
    console.log(`  ${mailbox}: scanned ${messages.length}, matched ${matched} (${knownContactCount} known contact)`);
  }

  const report = {
    scannedAt,
    since: sinceISO ?? null,
    mailboxes,
    counts,
    summary: {
      new: newFindings.length,
      possible_match: possibleMatchFindings.length,
      known_contact: knownContactFindings.length,
    },
    new: newFindings,
    possible_match: possibleMatchFindings,
    known_contact: knownContactFindings,
  };

  const outPath = args.out ?? path.join("data", "outlook-scans", `${scannedAt.replace(/[:.]/g, "-")}.json`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));

  console.log(`\n${newFindings.length} new, ${possibleMatchFindings.length} possible match, ${knownContactFindings.length} known contact.`);
  console.log(`Report written to ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
