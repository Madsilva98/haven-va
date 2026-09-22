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
import { buildContactLookups, domainOf, guessExternalParty, matchKnownContact, normalize } from "../dist/lib/outlook-contact-matching.js";

const DEFAULT_KEYWORDS = [
  "parceria", "parcerias", "parceiro", "parceira",
  "colaboração", "colaborar",
  "patrocínio", "patrocinar",
  "acordo comercial",
  "partnership", "partner", "collaboration", "sponsorship", "collab",
];

function parseArgs(argv) {
  const out = { since: undefined, mailboxes: [], out: undefined };
  for (const arg of argv) {
    if (arg.startsWith("--since=")) out.since = arg.slice("--since=".length);
    else if (arg.startsWith("--mailbox=")) out.mailboxes.push(arg.slice("--mailbox=".length));
    else if (arg.startsWith("--out=")) out.out = arg.slice("--out=".length);
  }
  return out;
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
      // No external recipient found (the Haven sent this, internal-only —
      // most often a founder forwarding a partnership email to the rest of
      // the team) — there's genuinely no name to guess. Surface that
      // honestly rather than falling back to the sender's own name (the
      // pre-2026-09-22 behavior, confirmed wrong for real: a founder's own
      // real name looks like a plausible partner name, not an obvious
      // red flag like "Geral"/"The Haven" would be). No dedup check either
      // — nothing to search for. The reviewer supplies partnerName by hand
      // in their decision if this really is a new partnership worth adding.
      if (!externalParty) {
        newFindings.push({
          ...baseFinding,
          matchType: "keyword",
          guessedPartnerName: null,
          guessedPartnerEmail: null,
          noExternalParty: true,
        });
        continue;
      }

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
