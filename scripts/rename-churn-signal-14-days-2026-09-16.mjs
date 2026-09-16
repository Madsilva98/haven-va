/**
 * One-off (2026-09-16): renames the "Sem reservas 21+ dias" Sinais option
 * on "Clientes em risco" to "Sem reservas 14+ dias". Matches the threshold
 * change in src/lib/churn-signals.ts (NO_BOOKING_GAP_DAYS 21 -> 14),
 * re-derived at the founder's request ("21 dias é já muito").
 *
 * IMPORTANT — two things learned the hard way running this live against
 * production, both now baked into the script below:
 *
 * 1. `dataSources.update`'s `options` array for a select/multi_select
 *    property REPLACES the whole enumeration, not merge-only. Passing
 *    just the one option being renamed silently deleted the other two
 *    ("Pagamento falhado", "Baixa utilização") from the schema. Every
 *    existing option must be listed every time.
 * 2. Passing `{ id: <existing-option-id>, name: <new-name> }` does NOT
 *    rename that option — Notion matched by id, decided it already
 *    existed, and kept its ORIGINAL name unchanged. There is no in-place
 *    rename via this endpoint (at least not via the SDK 2025-09-03
 *    dataSources.update path). The only thing that actually worked was:
 *    add the new name as a genuinely new option (no id in the request),
 *    then migrate each already-tagged page's Sinais value from the old
 *    option to the new one via pages.update, then remove the now-unused
 *    old option from the schema once nothing references it.
 *
 * Usage:
 *   node --env-file=.env.local scripts/rename-churn-signal-14-days-2026-09-16.mjs
 *
 * Not meant to be re-run after use.
 */

import { Client } from "@notionhq/client";

const notion = new Client({ auth: process.env.NOTION_API_KEY, notionVersion: "2025-09-03" });

const CHURN_RISK_DB_ID = process.env.NOTION_CHURN_RISK_DB_ID;
const OLD_NAME = "Sem reservas 21+ dias";
const NEW_NAME = "Sem reservas 14+ dias";
const OTHER_OPTION_NAMES = ["Pagamento falhado", "Baixa utilização"];

// Every open/closed row that had OLD_NAME as one of its Sinais when this
// ran — found by hand from the churn-risk run's own log output, since
// there's no "query rows by multi_select value" helper in src/notion.ts.
// Each of these had ONLY this one signal, so overwriting Sinais wholesale
// is safe; if a page had other signals too, this would need to read its
// current Sinais first and only swap the one entry.
const PAGE_IDS_WITH_OLD_SIGNAL = [
  "3dd53de7-d8bc-81d3-b36f-cf5fbda8601c", // Márcia Gonçalves
  "3dd53de7-d8bc-81ee-a88a-c125e6848b70", // Filipa Correia Rodrigues
  "3dd53de7-d8bc-81f5-ae47-ca0a4577c158", // Bruna Melim
  "3dd53de7-d8bc-818f-9598-e8ed4ad1430a", // Ana Sofia
];

async function getDataSourceId() {
  const db = await notion.databases.retrieve({ database_id: CHURN_RISK_DB_ID });
  const dataSources = db.data_sources ?? [];
  if (dataSources.length !== 1) {
    throw new Error(`expected exactly 1 data source, found ${dataSources.length}`);
  }
  return dataSources[0].id;
}

async function currentOptions(dataSourceId) {
  const ds = await notion.dataSources.retrieve({ data_source_id: dataSourceId });
  return ds.properties["Sinais"].multi_select.options;
}

async function main() {
  if (!CHURN_RISK_DB_ID) {
    console.error("NOTION_CHURN_RISK_DB_ID not set — nothing to fix.");
    process.exit(1);
  }

  const dataSourceId = await getDataSourceId();

  // Step 1: add the new option, keeping every existing one by id.
  const before = await currentOptions(dataSourceId);
  await notion.dataSources.update({
    data_source_id: dataSourceId,
    properties: {
      Sinais: {
        multi_select: {
          options: [...before.map((o) => ({ id: o.id, name: o.name })), { name: NEW_NAME }],
        },
      },
    },
  });
  console.log(`[schema] added "${NEW_NAME}"`);

  // Step 2: migrate every affected page from the old option to the new one.
  for (const pageId of PAGE_IDS_WITH_OLD_SIGNAL) {
    await notion.pages.update({
      page_id: pageId,
      properties: { Sinais: { multi_select: [{ name: NEW_NAME }] } },
    });
    console.log(`[page migrated] ${pageId}`);
  }

  // Step 3: remove the now-unused old option from the schema.
  const afterMigration = await currentOptions(dataSourceId);
  const remaining = afterMigration.filter((o) => o.name !== OLD_NAME);
  await notion.dataSources.update({
    data_source_id: dataSourceId,
    properties: {
      Sinais: { multi_select: { options: remaining.map((o) => ({ id: o.id, name: o.name })) } },
    },
  });
  console.log(
    "[schema] final options:",
    remaining.map((o) => o.name),
    "(expected:",
    [...OTHER_OPTION_NAMES, NEW_NAME],
    ")",
  );
}

main().catch((err) => {
  console.error("rename failed:", err.body ?? err.message);
  process.exit(1);
});
