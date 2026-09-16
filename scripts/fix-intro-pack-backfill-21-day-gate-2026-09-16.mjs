/**
 * One-off correction (2026-09-16), second pass on the summer backfill:
 *
 * 1. The founder decided the 21-day gate should apply to this backfill
 *    too, not just the standing weekly cron — "só quero os que acabaram
 *    há mais de 21 dias (os outros vão aparecendo à medida que os seus
 *    21 dias passam)". Archives (not deletes) any already-written lead
 *    whose pack finished less than 21 days ago; the standing
 *    leads-intro-pack.ts cron will naturally re-create it once it
 *    crosses the threshold (archived pages don't match
 *    notion.findLeadByEmail's open-lead query).
 *
 * 2. The 6 people marked "Convertido" by the previous repair script
 *    (fix-intro-pack-visit-stats-2026-09-16.mjs) kept their original
 *    Motivo text ("terminou há N dias, sem converter") unchanged — which
 *    reads as contradictory nonsense next to their (correct) recent
 *    "Última visita" date, since they in fact went on to become real
 *    members. The founder caught this on Luciana Aron specifically.
 *    Rewrites Motivo to say so plainly instead.
 *
 * Usage:
 *   npm run build
 *   node --env-file=.env.local scripts/fix-intro-pack-backfill-21-day-gate-2026-09-16.mjs           # dry run
 *   node --env-file=.env.local scripts/fix-intro-pack-backfill-21-day-gate-2026-09-16.mjs --apply   # actually archive/update
 *
 * Not meant to be re-run after use.
 */

import { DEFAULT_CUTOFF_DAYS, findUnconvertedIntroPacksInRange } from "../dist/lib/intro-pack-conversion.js";
import * as notion from "../dist/notion.js";

const FROM_ISO = "2026-05-01T00:00:00.000Z";
const TO_ISO = "2026-09-01T00:00:00.000Z";

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
    console.error("NOTION_LEADS_DB_ID not set — nothing to fix.");
    process.exit(1);
  }

  await notion.initialize();

  console.log(`--- Parte 1: arquivar quem tem menos de ${DEFAULT_CUTOFF_DAYS} dias ---`);
  const candidates = await findUnconvertedIntroPacksInRange(FROM_ISO, TO_ISO);
  const tooRecent = candidates.filter((c) => c.daysSinceExpiry < DEFAULT_CUTOFF_DAYS);
  console.log(`${candidates.length} candidatos no total, ${tooRecent.length} ainda com menos de ${DEFAULT_CUTOFF_DAYS} dias.`);

  let archived = 0;
  let archiveNotFound = 0;
  for (const c of tooRecent) {
    const existing = await notion.findLeadByEmail(c.email);
    if (!existing) {
      console.log(`[não encontrado — a saltar] ${c.name} <${c.email}> (${c.daysSinceExpiry} dias)`);
      archiveNotFound++;
      continue;
    }
    if (!apply) {
      console.log(`[dry-run] arquivaria: ${c.name} <${c.email}> (${c.daysSinceExpiry} dias)`);
      continue;
    }
    await notion.archivePage(existing.id);
    console.log(`[arquivado] ${c.name} <${c.email}> (${c.daysSinceExpiry} dias)`);
    archived++;
  }

  console.log(`\n--- Parte 2: corrigir o Motivo de quem já converteu ---`);
  let motivoFixed = 0;
  let motivoNotFound = 0;
  for (const email of ALREADY_CONVERTED_EMAILS) {
    // Not findLeadByEmail — these are already Estado=Convertido, which
    // that lookup deliberately excludes (it's built for open-lead dedup).
    const existing = await notion.findLeadByEmailAny(email);
    if (!existing) {
      console.log(`[não encontrado — a saltar] ${email}`);
      motivoNotFound++;
      continue;
    }
    const motivo = "Já converteu para mensalidade entretanto (visto no reprocessamento pós-correção do bug de paginação) — não precisa de seguimento como lead.";
    if (!apply) {
      console.log(`[dry-run] corrigiria motivo: ${email}`);
      continue;
    }
    await notion.updateLeadDetails(existing.id, { motivo });
    console.log(`[motivo corrigido] ${email}`);
    motivoFixed++;
  }

  if (!apply) {
    console.log(`\nDry run only — re-run with --apply to actually archive/update.`);
  } else {
    console.log(
      `\nDone: ${archived} arquivados (${archiveNotFound} não encontrados), ${motivoFixed} motivos corrigidos (${motivoNotFound} não encontrados).`,
    );
  }
}

main().catch((err) => {
  console.error("fix failed:", err);
  process.exit(1);
});
