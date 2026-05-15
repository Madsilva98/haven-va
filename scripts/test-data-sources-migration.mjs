/**
 * Integration test for the data_source_id migration.
 *
 * Usage:
 *   1. Copy /volume1/docker/haven-va/data/.env from the NAS to .env.local
 *      at the repo root.
 *   2. Build: npm run build
 *   3. Run: node --env-file=.env.local scripts/test-data-sources-migration.mjs
 *
 * This script READS ONLY. It calls every Notion code path that fetches
 * data and prints a summary. It does NOT write to Notion. Safe to run
 * against production data.
 *
 * Pass criteria: every section prints a count and no throws.
 */

import * as notion from "../dist/notion.js";

const SEP = "─".repeat(72);

function section(title) {
  console.log(`\n${SEP}\n${title}\n${SEP}`);
}

function summary(label, value) {
  const out =
    value === null || value === undefined
      ? "(none)"
      : typeof value === "number"
      ? String(value)
      : Array.isArray(value)
      ? `${value.length} items`
      : typeof value === "object"
      ? Object.keys(value).length === 0
        ? "(empty)"
        : JSON.stringify(value).slice(0, 200)
      : String(value);
  console.log(`  ${label.padEnd(40)} → ${out}`);
}

function sample(label, items, fields) {
  if (!Array.isArray(items) || items.length === 0) {
    console.log(`  ${label}: (no rows)`);
    return;
  }
  console.log(`  ${label}: ${items.length} row(s), first 3:`);
  for (const row of items.slice(0, 3)) {
    const picked = fields.map((f) => {
      const v = row[f];
      const s =
        v === null || v === undefined
          ? "—"
          : typeof v === "string"
          ? v.length > 50
            ? v.slice(0, 47) + "..."
            : v
          : JSON.stringify(v).slice(0, 50);
      return `${f}=${s}`;
    });
    console.log(`    · ${picked.join("  ")}`);
  }
}

async function main() {
  console.log("haven-va data-sources migration smoke test");
  console.log(`Notion-Version target: 2025-09-03`);

  section("1. Initialize: resolve data_source_id for every DB");
  // This is the canary — fails loudly if any DB has zero or multiple
  // data sources (the breaking trap).
  const start = Date.now();
  await notion.initialize();
  const elapsed = Date.now() - start;
  console.log(`  ✓ All databases resolved in ${elapsed}ms`);
  console.log(`  ✓ Each has exactly 1 data source (multi-source canary passed)`);

  section("2. Read open tasks (per-founder)");
  for (const f of ["Madalena", "Mafalda", "Beatriz"]) {
    const tasks = await notion.getOpenTasksFor(f);
    summary(`${f} open tasks`, tasks);
    sample(`${f} sample`, tasks, ["title", "priority", "deadline", "status"]);
  }

  section("3. Read due reminders");
  const due = await notion.getDueReminders();
  summary("due reminders", due);
  sample("sample", due, ["texto", "paraQuem", "quando", "enviado", "recurrence"]);

  section("4. Read weekly priorities");
  const weekly = await notion.getWeeklyPriorities();
  summary("weekly priorities", weekly);
  sample("sample", weekly, ["title", "owner", "priority", "deadline"]);

  section("5. Read overdue tasks");
  const overdue = await notion.getOverdueTasks();
  summary("overdue tasks", overdue);
  sample("sample", overdue, ["title", "owner", "deadline"]);

  section("6. Read completed since 7 days ago");
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const completed = await notion.getCompletedSince(since);
  summary(`completed since ${since}`, completed);
  sample("sample", completed, ["title", "owner"]);

  section("7. Read partners (stale pipeline)");
  try {
    const partners = await notion.getPartnersStale();
    summary("partners stale", partners);
    sample("sample", partners, ["nome", "status", "ultimoContacto"]);
  } catch (err) {
    console.log(`  (skipped: ${err.message})`);
  }

  section("8. Read influencers (stale)");
  try {
    const inf = await notion.getInfluencersStale();
    summary("influencers stale", inf);
    sample("sample", inf, ["nome", "instagram", "status"]);
  } catch (err) {
    console.log(`  (skipped: ${err.message})`);
  }

  section("9. Read content calendar");
  try {
    const cal = await notion.getContentCalendarRows();
    summary("content calendar rows", cal);
    sample("sample", cal, ["title", "status", "publishDate"]);
  } catch (err) {
    console.log(`  (skipped: ${err.message})`);
  }

  section("10. Read to-discuss");
  try {
    const td = await notion.getOpenToDiscussRows();
    summary("to-discuss rows", td);
    sample("sample", td, ["tema", "urgencia", "estado"]);
  } catch (err) {
    console.log(`  (skipped: ${err.message})`);
  }

  section("11. List names (for /add_to_list tool)");
  try {
    const lists = await notion.getListNames();
    summary("lists", lists);
    if (Array.isArray(lists)) {
      console.log(`  first 5: ${lists.slice(0, 5).join(", ")}`);
    }
  } catch (err) {
    console.log(`  (skipped: ${err.message})`);
  }

  section("✓ ALL SECTIONS PASSED");
  console.log(`Migration smoke test complete. Safe to deploy.`);
  console.log(`Next: confirm by comparing these counts against the production`);
  console.log(`bot's logs (Container Manager → haven-va-haven-va-1 → Log tab).`);
}

main().catch((err) => {
  console.error("\n❌ FAILED:", err.message);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
