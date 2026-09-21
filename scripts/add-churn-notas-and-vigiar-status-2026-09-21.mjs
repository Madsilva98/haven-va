/**
 * One-off (2026-09-21): adds two things to "Clientes em risco" per the
 * founder's request:
 *   1. A "Notas" rich_text property — hers to write in by hand, the bot
 *      never reads or writes it.
 *   2. A new "A vigiar" option on the Status select — for a row she wants
 *      to keep watching (e.g. one signal resolved, one still open) without
 *      marking it Resolvido/Arquivado. churn-risk.ts already treats any
 *      status other than Resolvido/Arquivado as open for signal syncing,
 *      so this needs no code change to keep updating — see the same-day
 *      commit that adds "A vigiar" to the reconciliation status list too.
 *
 * As learned running the 2026-09-16 Sinais rename against this same DB:
 * a select/multi_select options array is REPLACED wholesale on update, so
 * every existing option must be listed, not just the new one.
 *
 * Usage:
 *   node --env-file=.env.local scripts/add-churn-notas-and-vigiar-status-2026-09-21.mjs
 *
 * Not meant to be re-run after use.
 */

import { Client } from "@notionhq/client";

const notion = new Client({ auth: process.env.NOTION_API_KEY, notionVersion: "2025-09-03" });
const CHURN_RISK_DB_ID = process.env.NOTION_CHURN_RISK_DB_ID;

async function getDataSourceId() {
  const db = await notion.databases.retrieve({ database_id: CHURN_RISK_DB_ID });
  const dataSources = db.data_sources ?? [];
  if (dataSources.length !== 1) {
    throw new Error(`expected exactly 1 data source, found ${dataSources.length}`);
  }
  return dataSources[0].id;
}

async function main() {
  if (!CHURN_RISK_DB_ID) {
    console.error("NOTION_CHURN_RISK_DB_ID not set — nothing to fix.");
    process.exit(1);
  }

  const dataSourceId = await getDataSourceId();
  const ds = await notion.dataSources.retrieve({ data_source_id: dataSourceId });

  const existingStatusOptions = ds.properties["Status"].select.options;
  if (existingStatusOptions.some((o) => o.name === "A vigiar")) {
    console.log('[status] "A vigiar" already exists, skipping');
  } else {
    await notion.dataSources.update({
      data_source_id: dataSourceId,
      properties: {
        Status: {
          select: {
            options: [...existingStatusOptions.map((o) => ({ id: o.id, name: o.name })), { name: "A vigiar" }],
          },
        },
      },
    });
    console.log('[status] added "A vigiar"');
  }

  if (ds.properties["Notas"]) {
    console.log('[property] "Notas" already exists, skipping');
  } else {
    await notion.dataSources.update({
      data_source_id: dataSourceId,
      properties: {
        Notas: { rich_text: {} },
      },
    });
    console.log('[property] added "Notas" (rich_text)');
  }

  const after = await notion.dataSources.retrieve({ data_source_id: dataSourceId });
  console.log(
    "[status] final options:",
    after.properties["Status"].select.options.map((o) => o.name),
  );
  console.log("[property] has Notas:", Boolean(after.properties["Notas"]));
}

main().catch((err) => {
  console.error("migration failed:", err.body ?? err.message);
  process.exit(1);
});
