/**
 * Write-side integration test for the data_source_id migration.
 *
 * Exercises every notion.ts write path that uses
 *   parent: { type: "data_source_id", data_source_id: dsId(...) }
 *
 * Each test creates a CLEARLY-LABELED entry, captures the page_id,
 * verifies the response shape, then archives the entry (moves to
 * trash). If anything fails before archive, the test entry stays
 * findable in Notion via its [MIGRATION TEST] prefix so cleanup is
 * trivial.
 *
 * Usage:
 *   node --env-file=.env.local scripts/test-data-sources-writes.mjs
 *
 * Skipped on purpose:
 *   - setFounderFocus: would overwrite a real focus entry for this week
 *   - updateRecord: modifies existing data (the read-write status path
 *     is exercised indirectly by the cleanup via archivePage)
 */

import * as notion from "../dist/notion.js";

const TIMESTAMP = new Date().toISOString().slice(0, 19).replace("T", " ");
const PREFIX = `[MIGRATION TEST ${TIMESTAMP}]`;
const SEP = "─".repeat(72);

const results = [];

async function runWriteTest(label, testFn) {
  process.stdout.write(`  ${label.padEnd(40)} `);
  try {
    const pageId = await testFn();
    const cleanupOk = await tryArchive(pageId);
    const status = cleanupOk ? "✓ created + cleaned" : "✓ created — CLEANUP FAILED";
    console.log(`${status}  (id: ${pageId.slice(0, 8)}...)`);
    results.push({ label, status: "pass", pageId, cleanupOk });
  } catch (err) {
    console.log(`✗ FAIL`);
    console.log(`      → ${err.message}`);
    results.push({ label, status: "fail", error: err.message });
  }
}

async function tryArchive(pageId) {
  try {
    await notion.archivePage(pageId);
    return true;
  } catch (err) {
    console.log(`      ⚠ cleanup failed: ${err.message}`);
    return false;
  }
}

async function main() {
  console.log("haven-va data-sources WRITE migration test");
  console.log(`Test prefix: ${PREFIX}`);
  console.log(`Each entry is created then immediately archived.\n`);

  console.log(SEP);
  console.log("Initializing data_source_id resolver...");
  console.log(SEP);
  await notion.initialize();
  console.log(`✓ All 11 DBs resolved.\n`);

  console.log(SEP);
  console.log("Write tests");
  console.log(SEP);

  // 1. Backlog task
  await runWriteTest("createTask (Backlog)", async () =>
    notion.createTask(
      {
        title: `${PREFIX} test task`,
        owner: "Mafalda",
        area: "Tech",
        why: "migration verification",
      },
      "Média",
      `${PREFIX} originalMsg`,
      "Mafalda",
    ),
  );

  // 2. Reminder (set a date FAR in the future so the cron never sends it)
  await runWriteTest("createReminder (Reminders)", async () => {
    const farFuture = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 19);
    return notion.createReminder({
      texto: `${PREFIX} test reminder`,
      paraQuem: "Mafalda",
      quando: farFuture,
      origem: `${PREFIX} originalMsg`,
    });
  });

  // 3. Decision
  await runWriteTest("createDecision (Decisions)", async () =>
    notion.createDecision(
      {
        decisao: `${PREFIX} test decision`,
        area: "Tech",
        tomadaPor: ["Mafalda"],
        data: TIMESTAMP.slice(0, 10),
        estado: "Pendente implementação",
        notas: "migration verification",
      },
      `${PREFIX} originalMsg`,
    ),
  );

  // 4. ToDiscuss
  await runWriteTest("createToDiscuss (ToDiscuss)", async () =>
    notion.createToDiscuss(
      {
        tema: `${PREFIX} test topic`,
        adicionadoPor: "Mafalda",
        urgencia: "Decisão offline",
        area: "Tech",
        resolucao: "",
      },
      `${PREFIX} originalMsg`,
    ),
  );

  // 5. ContentCalendar entry
  await runWriteTest("createContentCalendarEntry (Content)", async () =>
    notion.createContentCalendarEntry({
      title: `${PREFIX} test content`,
      status: "raw idea",
    }),
  );

  // 6. Project entity
  await runWriteTest("createProject (Projects)", async () =>
    notion.createProject(
      `${PREFIX} test project`,
      "Mafalda",
      `${PREFIX} originalMsg`,
    ),
  );

  // 7. Event entity
  await runWriteTest("createEvent (Events)", async () =>
    notion.createEvent(
      `${PREFIX} test event`,
      "Mafalda",
      `${PREFIX} originalMsg`,
    ),
  );

  // 8. Partner entity
  await runWriteTest("createPartner (Partner Pipeline)", async () =>
    notion.createPartner(
      `${PREFIX} test partner`,
      "Mafalda",
      `${PREFIX} originalMsg`,
    ),
  );

  // 9. Influencer entity
  await runWriteTest("createInfluencer (Influencer Pipeline)", async () =>
    notion.createInfluencer(
      `${PREFIX} test influencer`,
      "Mafalda",
      `${PREFIX} originalMsg`,
    ),
  );

  // 10. addToList — creates a fresh test list item; the list itself is the
  // "Lista" select value on the item row, not a separate page.
  await runWriteTest("addToList (Lists)", async () =>
    notion.addToList(
      `${PREFIX} test item`,
      `${PREFIX} test list`,
      "Mafalda",
      `${PREFIX} originalMsg`,
    ),
  );

  console.log("");
  console.log(SEP);
  console.log("Summary");
  console.log(SEP);
  const passed = results.filter((r) => r.status === "pass").length;
  const failed = results.filter((r) => r.status === "fail").length;
  const cleanupFailed = results.filter(
    (r) => r.status === "pass" && r.cleanupOk === false,
  );

  console.log(`  ${passed} passed, ${failed} failed`);
  if (cleanupFailed.length > 0) {
    console.log(`  ⚠ ${cleanupFailed.length} test entries left in Notion (cleanup failed):`);
    cleanupFailed.forEach((r) =>
      console.log(`     · ${r.label}: ${r.pageId}`),
    );
    console.log(`  → Search Notion for "${PREFIX}" to find and remove manually.`);
  } else if (passed > 0 && failed === 0) {
    console.log(`  ✓ Every test entry was created AND archived successfully.`);
    console.log(`    Search Notion for "${PREFIX}" should return zero results`);
    console.log(`    (test entries are in trash, retrievable for 30 days).`);
  }

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("\n❌ UNEXPECTED FAILURE:", err.message);
  if (err.stack) console.error(err.stack);
  console.error(`\n⚠ Test entries may exist in Notion with prefix "${PREFIX}".`);
  console.error("  Search Notion for that prefix to find and remove them.");
  process.exit(1);
});
