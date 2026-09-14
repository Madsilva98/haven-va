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

  const sinceISO = args.since ? new Date(`${args.since}T00:00:00.000Z`).toISOString() : undefined;
  const scannedAt = new Date().toISOString();

  console.log(`Scanning ${mailboxes.length} mailbox(es), since=${sinceISO ?? "(full history)"}`);
  console.log(`Mailboxes: ${mailboxes.join(", ")}`);
  console.log(`Keywords: ${keywords.join(", ")}\n`);

  const newFindings = [];
  const possibleMatchFindings = [];
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
    for (const msg of messages) {
      const rawText = `${msg.subject}\n${msg.body}`;
      const haystack = normalize(rawText);
      const matchedKeywords = keywords.filter((kw) => haystack.includes(kw));
      if (matchedKeywords.length === 0) continue;
      matched++;

      const externalParty = guessExternalParty(msg.from, msg.to, ownDomains);
      const existing = await notion.findPageInDb("partners", externalParty.name);

      const finding = {
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
        guessedPartnerName: externalParty.name,
        guessedPartnerEmail: externalParty.email,
        webLink: msg.webLink,
      };

      if (existing) {
        possibleMatchFindings.push({ ...finding, matchedPage: existing });
      } else {
        newFindings.push(finding);
      }
    }

    counts[mailbox] = { scanned: messages.length, matched };
    console.log(`  ${mailbox}: scanned ${messages.length}, matched ${matched}`);
  }

  const report = {
    scannedAt,
    since: sinceISO ?? null,
    mailboxes,
    counts,
    summary: { new: newFindings.length, possible_match: possibleMatchFindings.length },
    new: newFindings,
    possible_match: possibleMatchFindings,
  };

  const outPath = args.out ?? path.join("data", "outlook-scans", `${scannedAt.replace(/[:.]/g, "-")}.json`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));

  console.log(`\n${newFindings.length} new, ${possibleMatchFindings.length} possible match to an existing partner.`);
  console.log(`Report written to ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
