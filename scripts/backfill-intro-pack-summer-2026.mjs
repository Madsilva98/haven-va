/**
 * One-off backfill: writes every person whose intro pack (2 Classes /
 * 10-Day Unlimited) expired between 2026-05-01 and 2026-08-31 and never
 * converted into the Notion "Leads a contactar" DB (Canal = "Intro Pack"),
 * with NO day-count gate.
 *
 * This is deliberately NOT part of the standing leads-intro-pack cron,
 * which always uses the validated 21-day threshold going forward. The
 * founder asked for this specific May-August window caught immediately as
 * a one-time exception, acknowledging the summer/vacation effect on
 * conversion timing found during validation (median time-to-convert
 * similar to the rest of the year, but a much longer tail — P90 of 61
 * days vs. 30 — for people who started their intro pack in June-August).
 * Not meant to be re-run for future summers; the standing 21-day rule
 * already reaches those people, just later.
 *
 * Usage:
 *   npm run build
 *   node --env-file=.env.local scripts/backfill-intro-pack-summer-2026.mjs           # dry run (default) — just prints who would be written
 *   node --env-file=.env.local scripts/backfill-intro-pack-summer-2026.mjs --apply   # actually writes to Notion
 */

import { findUnconvertedIntroPacksInRange } from "../dist/lib/intro-pack-conversion.js";
import * as notion from "../dist/notion.js";

const FROM_ISO = "2026-05-01T00:00:00.000Z";
const TO_ISO = "2026-09-01T00:00:00.000Z"; // exclusive upper bound — covers all of August

async function main() {
  const apply = process.argv.includes("--apply");

  if (!process.env.NOTION_LEADS_DB_ID) {
    console.error("NOTION_LEADS_DB_ID not set — nothing to write to.");
    process.exit(1);
  }

  await notion.initialize();

  const candidates = await findUnconvertedIntroPacksInRange(FROM_ISO, TO_ISO);
  console.log(`Found ${candidates.length} unconverted intro-pack finishers between 2026-05-01 and 2026-08-31.`);

  if (candidates.length === 0) {
    return;
  }

  let created = 0;
  let skippedExisting = 0;

  for (const c of candidates) {
    const expiresLabel = c.expiresAt.toLocaleDateString("pt-PT", { timeZone: "Europe/Lisbon" });
    const line = `- ${c.name} <${c.email}> ${c.phone ?? "(sem telefone)"} — ${c.packName}, terminou a ${expiresLabel} (${c.daysSinceExpiry} dias), ${c.visitCount} visita(s)`;

    if (!apply) {
      console.log(`[dry-run] ${line}`);
      continue;
    }

    const existing = await notion.findLeadByEmail(c.email);
    if (existing) {
      console.log(`[skip: já aberto] ${line}`);
      skippedExisting++;
      continue;
    }

    const motivo = `${c.packName} — terminou há ${c.daysSinceExpiry} dias, sem converter (backfill verão 2026)`;
    const origem = `Intro pack "${c.packName}" terminado a ${expiresLabel} — backfill one-off, efeito verão`;
    await notion.createLead(c.name, c.email, "Intro Pack", motivo, "N/A", origem, {
      telefone: c.phone,
      pack: c.packName,
      ultimaVisita: c.lastVisit ? c.lastVisit.toISOString() : null,
      nVisitas: c.visitCount,
    });
    console.log(`[criado] ${line}`);
    created++;
  }

  if (!apply) {
    console.log(`\nDry run only — re-run with --apply to write these ${candidates.length} rows to Notion.`);
  } else {
    console.log(`\nDone: ${created} criados, ${skippedExisting} já tinham um lead aberto.`);
  }
}

main().catch((err) => {
  console.error("backfill failed:", err);
  process.exit(1);
});
