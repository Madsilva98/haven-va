/**
 * One-off, surgical fix: restores "On hold" as a Status option on the
 * Partner Pipeline Notion database. src/types.ts's PartnerStatus type has
 * always included "On hold", but the live database (and
 * scripts/setup-notion-dbs.mjs's declared schema) didn't have it — the
 * founder asked for it back 2026-09-21 while reviewing how Instagram DM
 * networking contacts should be routed into this same DB. Already applied
 * to production 2026-09-21 — kept for reproducibility/audit trail, not
 * meant to be re-run.
 *
 * Touches ONLY the Partner Pipeline Status property — deliberately not the
 * full scripts/setup-notion-dbs.mjs run, which would push every DB's
 * declared schema at once.
 *
 * Usage: node --env-file=.env.local scripts/restore-partner-on-hold-status.mjs
 */

import { Client } from "@notionhq/client";

const notion = new Client({ auth: process.env.NOTION_API_KEY, notionVersion: "2025-09-03" });

async function main() {
  const dbId = process.env.NOTION_PARTNER_DB_ID;
  if (!dbId) {
    console.error("NOTION_PARTNER_DB_ID not set.");
    process.exit(1);
  }

  const db = await notion.databases.retrieve({ database_id: dbId });
  const dataSources = db.data_sources ?? [];
  if (dataSources.length !== 1) {
    throw new Error(`expected exactly 1 data source, found ${dataSources.length}`);
  }

  const res = await notion.dataSources.update({
    data_source_id: dataSources[0].id,
    properties: {
      Status: {
        select: {
          options: [
            { name: "A contactar" },
            { name: "Contactado" },
            { name: "A aguardar resposta" },
            { name: "Em negociação" },
            { name: "On hold" },
            { name: "Fechado" },
            { name: "Arquivado" },
          ],
        },
      },
    },
  });

  const statusOptions = res.properties.Status.select.options.map((o) => o.name);
  console.log("Status options now:", statusOptions.join(", "));
}

main().catch((err) => {
  console.error("failed:", err.body ?? err.message);
  process.exit(1);
});
