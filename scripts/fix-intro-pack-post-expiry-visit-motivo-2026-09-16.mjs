/**
 * One-off correction (2026-09-16): some open Intro Pack leads visited
 * again after their pack's own expiry date (a paid drop-in class), but
 * never started an actual subscription/non-intro membership — so
 * hasConvertedAfter correctly still says "sem converter", but the Motivo
 * text didn't say they'd come back, which reads as contradictory next to
 * a recent "Última visita" date. The founder caught this on Liza
 * Kupriievych: pack expired 16/07/2026, but she paid for and attended a
 * one-off Yin Yoga class on 25/08/2026 — never bought a plan.
 *
 * Rewrites Motivo on any currently-open Intro Pack lead where this
 * applies, using the same describePostExpiryVisit() the standing
 * leads-intro-pack.ts cron now uses for all future writes.
 *
 * Usage:
 *   npm run build
 *   node --env-file=.env.local scripts/fix-intro-pack-post-expiry-visit-motivo-2026-09-16.mjs           # dry run
 *   node --env-file=.env.local scripts/fix-intro-pack-post-expiry-visit-motivo-2026-09-16.mjs --apply   # actually update
 *
 * Not meant to be re-run after use — the standing cron now writes this
 * correctly from the start.
 */

import { describePostExpiryVisit, findUnconvertedIntroPacks } from "../dist/lib/intro-pack-conversion.js";
import * as notion from "../dist/notion.js";

async function main() {
  const apply = process.argv.includes("--apply");

  if (!process.env.NOTION_LEADS_DB_ID) {
    console.error("NOTION_LEADS_DB_ID not set — nothing to fix.");
    process.exit(1);
  }

  await notion.initialize();

  const open = await notion.getLeadsByEstado(["Novo", "Contactado"]);
  const introPackRows = open.filter((r) => r.canal === "Intro Pack");
  console.log(`${introPackRows.length} leads Intro Pack abertos.`);

  // cutoffDays=0 — these leads are already written; we just need the
  // recomputed lastVisit/expiresAt/daysSinceExpiry per email, not a fresh
  // day-21 gate.
  const { candidates } = await findUnconvertedIntroPacks(0);
  const byEmail = new Map(candidates.map((c) => [c.email, c]));

  let fixed = 0;
  let skippedNoNote = 0;
  let skippedNoMatch = 0;

  for (const row of introPackRows) {
    if (!row.email) continue;
    const c = byEmail.get(row.email.toLowerCase().trim());
    if (!c) {
      skippedNoMatch++;
      continue;
    }
    const note = describePostExpiryVisit(c);
    if (!note) {
      skippedNoNote++;
      continue;
    }
    const motivo = `${c.packName} — terminou há ${c.daysSinceExpiry} dias, sem converter para mensalidade — ${note}`;
    if (!apply) {
      console.log(`[dry-run] corrigiria motivo: ${c.name} <${c.email}> — ${note}`);
      continue;
    }
    await notion.updateLeadDetails(row.id, { motivo });
    console.log(`[motivo corrigido] ${c.name} <${c.email}> — ${note}`);
    fixed++;
  }

  if (!apply) {
    console.log(`\nDry run only — re-run with --apply to actually update.`);
  } else {
    console.log(
      `\nDone: ${fixed} motivos corrigidos, ${skippedNoNote} sem nota a acrescentar, ${skippedNoMatch} sem correspondência.`,
    );
  }
}

main().catch((err) => {
  console.error("fix failed:", err);
  process.exit(1);
});
