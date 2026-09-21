/**
 * One-off backfill for the competitor-intel pipeline: processes whatever is
 * currently tagged with COMPETITOR_INTEL_LABEL (default "email marketing
 * concorrência") right now — the real backlog that predates this code —
 * without touching the Inbox/tidy phase at all. Reuses the exact same
 * processing logic as the weekly cron (src/crons/competitor-intel.ts).
 *
 * Run this once after /auth_gmail has been completed, to get the existing
 * backlog into Notion immediately instead of waiting for the next Monday
 * run. Safe to re-run — anything already labelled "processado" is skipped.
 *
 * Usage:
 *   npm run build
 *   COMPETITOR_INTEL_DRY_RUN=true node --env-file=.env.local scripts/backfill-competitor-intel.mjs   # sanity-check first
 *   node --env-file=.env.local scripts/backfill-competitor-intel.mjs                                  # real run
 *
 * See docs/knowledge-base/competitor-intel.md.
 */

import * as gmail from "../dist/lib/gmail.js";
import { processTaggedCompetitorEmails, isDryRun } from "../dist/lib/competitor-intel-pipeline.js";
import * as notion from "../dist/notion.js";

async function main() {
  if (!process.env.NOTION_COMPETITOR_SOURCES_DB_ID || !process.env.NOTION_COMPETITOR_INTEL_DB_ID) {
    console.error("Missing NOTION_COMPETITOR_SOURCES_DB_ID / NOTION_COMPETITOR_INTEL_DB_ID — fill .env first");
    process.exit(1);
  }
  if (!gmail.isAuthenticated()) {
    console.error("Gmail not authenticated — run /auth_gmail in Madalena's Telegram DM first");
    process.exit(1);
  }

  await notion.initialize();

  const dryRun = isDryRun();
  console.log(`Backfilling competitor-intel${dryRun ? " (DRY RUN — nothing will be written)" : ""}...\n`);

  const summary = await processTaggedCompetitorEmails();

  console.log(`\nMessages seen:      ${summary.messagesSeen}`);
  console.log(`Messages processed:  ${summary.messagesProcessed}`);
  console.log(`Findings written:    ${summary.findingsWritten}`);
  console.log(`Errors:              ${summary.errors}`);

  if (summary.byMessage.length > 0) {
    console.log("\nBreakdown:");
    for (const msg of summary.byMessage) {
      if (msg.findings.length === 0) continue;
      console.log(`\n  ${msg.fromName} <${msg.fromEmail}> — "${msg.subject}"`);
      for (const f of msg.findings) {
        console.log(`    - [${f.tipo}] ${f.resumo}`);
      }
    }
  }

  if (summary.errors > 0) {
    console.log("\nSome messages errored and were left unlabelled — re-run this script to retry them.");
  }
}

main().catch((err) => {
  console.error("backfill failed:", err);
  process.exit(1);
});
