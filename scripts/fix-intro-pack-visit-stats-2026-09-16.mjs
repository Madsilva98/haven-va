/**
 * One-off data repair (2026-09-16): the 95 leads written by
 * backfill-intro-pack-summer-2026.mjs earlier the same day were computed
 * before the Supabase pagination fix (src/lib/studio-supabase.ts
 * fetchAllPages) — kenko_bookings/kenko_customers queries silently
 * returned only the first 1000 rows, so "Nº de visitas"/"Última visita"
 * (and possibly "Telefone") were wrong/missing for anyone whose data fell
 * past that cutoff.
 *
 * Re-runs the now-fixed lookup for the same May-Aug 2026 window and
 * updates each already-existing lead's structured fields in place — does
 * NOT create new rows (uses notion.findLeadByEmail + notion.updateLeadDetails,
 * never notion.createLead).
 *
 * Usage:
 *   npm run build
 *   node --env-file=.env.local scripts/fix-intro-pack-visit-stats-2026-09-16.mjs           # dry run (default)
 *   node --env-file=.env.local scripts/fix-intro-pack-visit-stats-2026-09-16.mjs --apply    # actually update Notion
 *
 * Not meant to be re-run after use — kept committed as a record of the
 * repair, same convention as the original backfill script.
 */

import { findUnconvertedIntroPacksInRange } from "../dist/lib/intro-pack-conversion.js";
import * as notion from "../dist/notion.js";

const FROM_ISO = "2026-05-01T00:00:00.000Z";
const TO_ISO = "2026-09-01T00:00:00.000Z";

async function main() {
  const apply = process.argv.includes("--apply");

  if (!process.env.NOTION_LEADS_DB_ID) {
    console.error("NOTION_LEADS_DB_ID not set — nothing to fix.");
    process.exit(1);
  }

  await notion.initialize();

  const candidates = await findUnconvertedIntroPacksInRange(FROM_ISO, TO_ISO);
  console.log(`Re-computed ${candidates.length} unconverted intro-pack finishers (post-fix).`);

  let updated = 0;
  let notFound = 0;

  for (const c of candidates) {
    const existing = await notion.findLeadByEmail(c.email);
    if (!existing) {
      console.log(`[não encontrado — a saltar] ${c.name} <${c.email}>`);
      notFound++;
      continue;
    }

    const line = `- ${c.name} <${c.email}> ${c.phone ?? "(sem telefone)"} — ${c.visitCount} visita(s), última: ${c.lastVisit ? c.lastVisit.toISOString().slice(0, 10) : "nunca"}`;

    if (!apply) {
      console.log(`[dry-run] ${line}`);
      continue;
    }

    await notion.updateLeadDetails(existing.id, {
      telefone: c.phone,
      pack: c.packName,
      ultimaVisita: c.lastVisit ? c.lastVisit.toISOString() : null,
      nVisitas: c.visitCount,
    });
    console.log(`[corrigido] ${line}`);
    updated++;
  }

  if (!apply) {
    console.log(`\nDry run only — re-run with --apply to write the corrected values to Notion.`);
  } else {
    console.log(`\nDone: ${updated} corrigidos, ${notFound} não encontrados no Notion (já removidos/renomeados?).`);
  }
}

main().catch((err) => {
  console.error("fix failed:", err);
  process.exit(1);
});
