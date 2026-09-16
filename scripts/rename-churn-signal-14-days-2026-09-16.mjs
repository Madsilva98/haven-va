/**
 * One-off (2026-09-16): renames the "Sem reservas 21+ dias" Sinais option
 * on "Clientes em risco" to "Sem reservas 14+ dias", in place (by option
 * id, not by adding a new option) — this also relabels every row already
 * tagged with the old name, no per-row data migration needed. Matches the
 * threshold change in src/lib/churn-signals.ts (NO_BOOKING_GAP_DAYS 21 -> 14),
 * re-derived at the founder's request ("21 dias é já muito").
 *
 * Usage:
 *   node --env-file=.env.local scripts/rename-churn-signal-14-days-2026-09-16.mjs
 *
 * Not meant to be re-run after use.
 */

import { Client } from "@notionhq/client";

const notion = new Client({ auth: process.env.NOTION_API_KEY, notionVersion: "2025-09-03" });

const CHURN_RISK_DB_ID = process.env.NOTION_CHURN_RISK_DB_ID;
const OLD_OPTION_ID = "1420772a-5725-4350-9dd9-39c44e409c38";
const NEW_NAME = "Sem reservas 14+ dias";

async function main() {
  if (!CHURN_RISK_DB_ID) {
    console.error("NOTION_CHURN_RISK_DB_ID not set — nothing to fix.");
    process.exit(1);
  }

  const db = await notion.databases.retrieve({ database_id: CHURN_RISK_DB_ID });
  const dataSources = db.data_sources ?? [];
  if (dataSources.length !== 1) {
    throw new Error(`expected exactly 1 data source, found ${dataSources.length}`);
  }

  const res = await notion.dataSources.update({
    data_source_id: dataSources[0].id,
    properties: {
      Sinais: {
        multi_select: {
          options: [{ id: OLD_OPTION_ID, name: NEW_NAME }],
        },
      },
    },
  });

  const sinaisOptions = res.properties["Sinais"].multi_select.options;
  console.log("Sinais options after rename:", sinaisOptions.map((o) => o.name));
}

main().catch((err) => {
  console.error("rename failed:", err.body ?? err.message);
  process.exit(1);
});
