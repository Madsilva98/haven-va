/**
 * One-off follow-up (2026-09-16): the 6 people already marked
 * Estado="Convertido" (see fix-intro-pack-visit-stats-2026-09-16.mjs and
 * fix-intro-pack-backfill-21-day-gate-2026-09-16.mjs) don't need to sit in
 * "Leads a contactar" at all, per the founder — archives them outright
 * rather than leaving a Convertido row behind.
 *
 * Usage:
 *   npm run build
 *   node --env-file=.env.local scripts/archive-converted-intro-pack-leads-2026-09-16.mjs           # dry run
 *   node --env-file=.env.local scripts/archive-converted-intro-pack-leads-2026-09-16.mjs --apply    # actually archive
 */

import * as notion from "../dist/notion.js";

const ALREADY_CONVERTED_EMAILS = [
  "aespidel6@gmail.com",
  "luciana.aron@gmail.com",
  "sr.gomes@hotmail.com",
  "siriarivarola2002@gmail.com",
  "inesgrizi@gmail.com",
  "majgre@proton.me",
];

async function main() {
  const apply = process.argv.includes("--apply");

  if (!process.env.NOTION_LEADS_DB_ID) {
    console.error("NOTION_LEADS_DB_ID not set — nothing to do.");
    process.exit(1);
  }

  await notion.initialize();

  let archived = 0;
  let notFound = 0;

  for (const email of ALREADY_CONVERTED_EMAILS) {
    const existing = await notion.findLeadByEmailAny(email);
    if (!existing) {
      console.log(`[não encontrado — a saltar] ${email}`);
      notFound++;
      continue;
    }
    if (!apply) {
      console.log(`[dry-run] arquivaria: ${email}`);
      continue;
    }
    await notion.archivePage(existing.id);
    console.log(`[arquivado] ${email}`);
    archived++;
  }

  if (!apply) {
    console.log(`\nDry run only — re-run with --apply to actually archive.`);
  } else {
    console.log(`\nDone: ${archived} arquivados, ${notFound} não encontrados.`);
  }
}

main().catch((err) => {
  console.error("failed:", err);
  process.exit(1);
});
