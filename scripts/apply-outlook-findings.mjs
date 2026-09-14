/**
 * The only script allowed to write partnership findings into Notion.
 * Takes a scan report (from scripts/scan-outlook-partnerships.mjs) plus a
 * human-reviewed decisions file, and applies exactly those decisions.
 *
 * Never runs unattended — decisions must be produced by a human reviewing
 * the scan report first (conversationally with Claude Code, or by hand).
 * The "intelligent" part (reading the email and drafting a status, next
 * step, owner guess, and page-body content) happens during that review —
 * this script just writes whatever ends up in the decisions file.
 *
 * Usage:
 *   node --env-file=.env.local scripts/apply-outlook-findings.mjs --scan=data/outlook-scans/<file>.json --approve=<path-to-decisions.json>
 *
 * decisions.json shape: an array of
 *   {
 *     "findingId": "...",
 *     "action": "create" | "update" | "skip",
 *     "partnerName"?: "...",             // overrides finding.guessedPartnerName
 *     "email"?: "...",                   // overrides finding.guessedPartnerEmail
 *     "owner"?: "Madalena"|"Mafalda"|"Beatriz"|"Unassigned",
 *     "status"?: "A contactar"|"Contactado"|"A aguardar resposta"|"Em negociação"|"Fechado"|"Arquivado"|"On hold",
 *     "proximoPasso"?: "...",
 *     "bodySections"?: { "🤝 Sobre o parceiro": "...", "💼 Deal e proposta": "..." },
 *     "matchedPageId"?: "..."            // required for "update" unless finding.matchedPage.id is present
 *   }
 *
 * - create: makes a new Partner Pipeline row via notion.createPartner(),
 *   then a single follow-up write sets Status (defaults to "A contactar"
 *   if omitted — createPartner()'s own default), Próximo passo, Email, and
 *   Último contacto (always set to the finding's email date). bodySections
 *   are appended into the page's toggle sections.
 * - update: same follow-up write applied to the existing page. Último
 *   contacto always moves to the new finding's date — that's the point of
 *   re-syncing. Notas is deliberately left untouched (not auto-filled).
 * - skip: no-op, just marks the finding reviewed.
 *
 * See docs/knowledge-base/outlook-partnerships-sync.md.
 */

import fs from "node:fs";
import { Client } from "@notionhq/client";
import * as notion from "../dist/notion.js";

const notionRaw = new Client({ auth: process.env.NOTION_API_KEY, notionVersion: "2025-09-03" });

function parseArgs(argv) {
  const out = {};
  for (const arg of argv) {
    if (arg.startsWith("--scan=")) out.scan = arg.slice("--scan=".length);
    else if (arg.startsWith("--approve=")) out.approve = arg.slice("--approve=".length);
  }
  return out;
}

function formatOrigem(finding) {
  const to = (finding.to ?? []).map((r) => `${r.name} <${r.email}>`).join(", ");
  return [
    `[Outlook sync] ${finding.mailbox}`,
    `De: ${finding.from.name} <${finding.from.email}>`,
    ...(to ? [`Para: ${to}`] : []),
    `Assunto: ${finding.subject}`,
    `Data: ${finding.receivedDate}`,
    `Palavras-chave: ${finding.matchedKeywords.join(", ")}`,
    "",
    finding.snippet,
    "",
    finding.webLink,
  ].join("\n");
}

// Single place that decides what goes into "Último contacto" / "Status" /
// "Próximo passo" / "Email" — used for both create and update, so
// re-syncing the same partner always advances the contact date.
function buildPartnerProperties(decision, finding) {
  const props = {
    "Último contacto": { date: { start: finding.receivedDate.slice(0, 10) } },
  };
  if (decision.status) {
    // Partner Pipeline's live "Status" property is a select, not Notion's
    // status type — see docs/knowledge-base/notion-api-gotchas.md.
    props["Status"] = { select: { name: decision.status } };
  }
  if (decision.proximoPasso) {
    props["Próximo passo"] = { rich_text: [{ text: { content: decision.proximoPasso } }] };
  }
  const email = decision.email ?? finding.guessedPartnerEmail;
  if (email) {
    props["Email"] = { email };
  }
  return props;
}

async function applyBodySections(pageId, bodySections) {
  for (const [section, text] of Object.entries(bodySections ?? {})) {
    if (!text || !text.trim()) continue;
    await notion.appendToPageSection(pageId, text, section);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.scan || !args.approve) {
    console.error("Usage: apply-outlook-findings.mjs --scan=<report.json> --approve=<decisions.json>");
    process.exit(1);
  }

  await notion.initialize();

  const report = JSON.parse(fs.readFileSync(args.scan, "utf8"));
  const decisions = JSON.parse(fs.readFileSync(args.approve, "utf8"));

  const allFindings = new Map(
    [...report.new, ...report.possible_match].map((f) => [f.findingId, f]),
  );

  for (const decision of decisions) {
    const finding = allFindings.get(decision.findingId);
    if (!finding) {
      console.error(`  ✗ ${decision.findingId}: not found in scan report — skipping`);
      continue;
    }

    if (decision.action === "skip") {
      console.log(`  – ${decision.findingId}: skipped`);
      continue;
    }

    if (decision.action === "create") {
      const nome = decision.partnerName ?? finding.guessedPartnerName;

      // Re-check for a match on the FINAL name, not just finding.guessedPartnerName
      // — the scan's dedup ran before review, so a human correcting the guessed
      // name (e.g. a contact's name → the actual company name) can turn a
      // scan-time "new" into a real existing row. Skipping this check created a
      // duplicate "Track & Field" partner during initial testing (2026-09-14).
      const recheck = await notion.findPageInDb("partners", nome);
      if (recheck) {
        console.error(
          `  ✗ ${decision.findingId}: "${nome}" already exists as "${recheck.title}" (${recheck.id}) — skipping create. Use action "update" with matchedPageId="${recheck.id}" instead.`,
        );
        continue;
      }

      const owner = decision.owner ?? "Unassigned";
      const pageId = await notion.createPartner(nome, owner, formatOrigem(finding));
      await notionRaw.pages.update({ page_id: pageId, properties: buildPartnerProperties(decision, finding) });
      await applyBodySections(pageId, decision.bodySections);
      console.log(`  ✓ ${decision.findingId}: created "${nome}" (${pageId})`);
      continue;
    }

    if (decision.action === "update") {
      const pageId = decision.matchedPageId ?? finding.matchedPage?.id;
      if (!pageId) {
        console.error(`  ✗ ${decision.findingId}: update requires matchedPageId — skipping`);
        continue;
      }
      await notionRaw.pages.update({ page_id: pageId, properties: buildPartnerProperties(decision, finding) });
      await applyBodySections(pageId, decision.bodySections);
      console.log(`  ✓ ${decision.findingId}: updated (${pageId})`);
      continue;
    }

    console.error(`  ✗ ${decision.findingId}: unknown action "${decision.action}"`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
