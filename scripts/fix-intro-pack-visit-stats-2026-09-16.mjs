/**
 * One-off data repair (2026-09-16): the 95 leads written by
 * backfill-intro-pack-summer-2026.mjs earlier the same day were computed
 * before the Supabase pagination fix (src/lib/studio-supabase.ts
 * fetchAllPages) — kenko_bookings/kenko_customers/kenko_memberships
 * queries silently returned only the first 1000 rows.
 *
 * Two distinct corrections, both from re-running the now-fixed lookup for
 * the same May-Aug 2026 window:
 * 1. "Nº de visitas"/"Última visita"/"Telefone" were wrong/missing for
 *    anyone whose data fell past the old 1000-row cutoff — corrected in
 *    place via notion.updateLeadDetails (never creates new rows).
 * 2. The pagination bug ALSO under-counted kenko_memberships, so the
 *    "did this person actually convert?" check itself was wrong for some
 *    people — 6 of the original 95 had, in fact, already converted to a
 *    real membership and should never have been written as open leads.
 *    Diffing the original 95 against the corrected re-run identified
 *    exactly these 6 (hardcoded below, tied to this specific incident —
 *    not a general "reconcile leads" mechanism); their Estado is set to
 *    "Convertido" via notion.setLeadEstado rather than deleted, so the
 *    row stays as an audit trail of what happened.
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

// Present in the original 95-person backfill, absent from the re-run
// against the fixed pagination — i.e. they'd actually already converted.
const ALREADY_CONVERTED_EMAILS = [
  "aespidel6@gmail.com", // Adriana Silva
  "luciana.aron@gmail.com", // Luciana Aron
  "sr.gomes@hotmail.com", // Sandra Gomes
  "siriarivarola2002@gmail.com", // Siria Segovia
  "inesgrizi@gmail.com", // Inês Grizi
  "majgre@proton.me", // Mara Mara
];

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

  console.log(`\n--- Já converteram (não deviam ter sido criados como leads) ---`);
  let markedConverted = 0;
  let convertedNotFound = 0;
  for (const email of ALREADY_CONVERTED_EMAILS) {
    const existing = await notion.findLeadByEmail(email);
    if (!existing) {
      console.log(`[não encontrado — a saltar] ${email}`);
      convertedNotFound++;
      continue;
    }
    if (!apply) {
      console.log(`[dry-run] marcaria "Convertido": ${email}`);
      continue;
    }
    await notion.setLeadEstado(existing.id, "Convertido");
    console.log(`[marcado Convertido] ${email}`);
    markedConverted++;
  }

  if (!apply) {
    console.log(`\nDry run only — re-run with --apply to write the corrected values to Notion.`);
  } else {
    console.log(
      `\nDone: ${updated} corrigidos, ${notFound} não encontrados; ${markedConverted} marcados Convertido, ${convertedNotFound} não encontrados.`,
    );
  }
}

main().catch((err) => {
  console.error("fix failed:", err);
  process.exit(1);
});
