/**
 * One-off, surgical fix: adds "A vigiar" as a real Status option on the
 * "Clientes em risco" Notion database. src/crons/churn-risk.ts has queried
 * for Status="A vigiar" since 2026-09-21 (CLAUDE.md documented it as a real
 * option the founder can set by hand), but it was never actually added to
 * the live database — every weekly run's `getChurnRowsByStatus(["Aberto",
 * "Contactado", "A vigiar"])` call has been failing with a 400
 * validation_error ("select option \"A vigiar\" not found") ever since,
 * silently skipping the whole archive-resolved-rows reconciliation step.
 * Found 2026-09-28 while investigating a founder report of stale churn-risk
 * entries.
 *
 * Touches ONLY the Clientes em risco Status property — same surgical
 * pattern as scripts/restore-partner-on-hold-status.mjs: read the real
 * current option list first, only ever append, never hand-type a
 * replacement (see docs/knowledge-base/notion-api-gotchas.md's 2026-09-07
 * incident for why passing select.options: [] wipes everything).
 *
 * Usage: node --env-file=.env.local scripts/add-a-vigiar-status-churn-risk.mjs
 */

import { Client } from "@notionhq/client";

const notion = new Client({ auth: process.env.NOTION_API_KEY, notionVersion: "2025-09-03" });

async function main() {
  const dbId = process.env.NOTION_CHURN_RISK_DB_ID;
  if (!dbId) {
    console.error("NOTION_CHURN_RISK_DB_ID not set.");
    process.exit(1);
  }

  const db = await notion.databases.retrieve({ database_id: dbId });
  const dataSources = db.data_sources ?? [];
  if (dataSources.length !== 1) {
    throw new Error(`expected exactly 1 data source, found ${dataSources.length}`);
  }

  const dataSourceId = dataSources[0].id;
  const current = await notion.dataSources.retrieve({ data_source_id: dataSourceId });
  const existingNames = current.properties.Status.select.options.map((o) => o.name);
  console.log("Existing Status options:", existingNames.join(", "));

  if (existingNames.includes("A vigiar")) {
    console.log('"A vigiar" already present — nothing to do.');
    return;
  }

  const res = await notion.dataSources.update({
    data_source_id: dataSourceId,
    properties: {
      Status: {
        select: {
          options: [...existingNames.map((name) => ({ name })), { name: "A vigiar" }],
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
