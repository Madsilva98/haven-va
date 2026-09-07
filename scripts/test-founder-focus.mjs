/**
 * Integration test for the Founder Focus body/edit tools and the
 * Semana-formula→number migration.
 *
 * Uses a far-future, never-real week number (`weekOfYear() + 500`) so the
 * test row can never collide with anyone's real active-week row.
 *
 * Usage:
 *   npm run build
 *   node --env-file=.env.local scripts/test-founder-focus.mjs
 *
 * Skipped on purpose (same reasoning as `test-data-sources-writes.mjs`
 * skipping `setFounderFocus`): anything that touches `Ativo` —
 * `rolloverFounderFocusWeek`, `deactivatePreviousFocus`, and
 * `getOrCreateFounderFocusRow(..., { activate: true })` — is NOT
 * exercised here. `deactivatePreviousFocus` deactivates every Ativo=true
 * row for a founder with no week filter, so running it against a real
 * founder would silently kill their real current-week active row. Verify
 * those paths manually in a Telegram test chat instead (see the plan's
 * manual test-plan step).
 */

import * as notion from "../dist/notion.js";
import { weekOfYear } from "../dist/lib/week.js";

const FOUNDER = "Mafalda";
const TEST_WEEK = weekOfYear() + 500; // never a real week
const SEP = "─".repeat(72);
const results = [];
let testPageId = null;

function check(label, condition, detail) {
  if (condition) {
    console.log(`  ✓ ${label}`);
    results.push({ label, status: "pass" });
  } else {
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
    results.push({ label, status: "fail", detail });
  }
}

async function main() {
  console.log("haven-va Founder Focus integration test");
  console.log(`Founder: ${FOUNDER}  Test week: ${TEST_WEEK} (never real)\n`);

  console.log(SEP);
  console.log("Initializing data_source_id resolver...");
  console.log(SEP);
  await notion.initialize();
  console.log("✓ resolved\n");

  console.log(SEP);
  console.log("1. getOrCreateFounderFocusRow — create + idempotent reuse");
  console.log(SEP);
  testPageId = await notion.getOrCreateFounderFocusRow(FOUNDER, TEST_WEEK, { activate: false });
  check("row created", typeof testPageId === "string" && testPageId.length > 0);

  const samePageId = await notion.getOrCreateFounderFocusRow(FOUNDER, TEST_WEEK, { activate: false });
  check("second call reuses same row (no duplicate)", samePageId === testPageId);

  console.log("");
  console.log(SEP);
  console.log("2. getFounderFocusForWeek — Semana number filter (the migration's risky bit)");
  console.log(SEP);
  const forWeek = await notion.getFounderFocusForWeek(TEST_WEEK);
  const mine = forWeek.find((e) => e.founder === FOUNDER);
  check("row found via number filter (no validation_error)", Boolean(mine));
  check("weekNumber round-trips correctly", mine?.weekNumber === TEST_WEEK, `got ${mine?.weekNumber}`);

  console.log("");
  console.log(SEP);
  console.log("3. appendFounderFocusBody — own content + cross-founder note");
  console.log(SEP);
  const ownLine = `linha própria ${Date.now()}`;
  await notion.appendFounderFocusBody(testPageId, ownLine);
  console.log(`  ✓ appended own line`);

  const crossLine = `linha cruzada ${Date.now()}`;
  await notion.appendFounderFocusBody(testPageId, crossLine, { addedBy: "Madalena", when: new Date() });
  console.log(`  ✓ appended cross-founder line with note`);

  console.log("");
  console.log(SEP);
  console.log("4. editFounderFocusBodyItem — edit, ambiguous match, remove, not-found");
  console.log(SEP);

  // Edit — new text deliberately shares no substring with the old, so a
  // stale match would be a real bug, not just substring overlap noise.
  const editedLine = `conteúdo totalmente distinto ${Date.now()}`;
  await notion.editFounderFocusBodyItem(testPageId, ownLine, editedLine);
  console.log(`  ✓ edited own line`);
  try {
    await notion.editFounderFocusBodyItem(testPageId, ownLine, "não devia encontrar");
    check("edited line no longer findable by old text", false, "old text still matched");
  } catch {
    check("edited line no longer findable by old text", true);
  }
  await notion.editFounderFocusBodyItem(testPageId, editedLine, undefined);

  // Ambiguity: two lines sharing a substring
  const sharedNeedle = `partilhado-${Date.now()}`;
  await notion.appendFounderFocusBody(testPageId, `${sharedNeedle} um`);
  await notion.appendFounderFocusBody(testPageId, `${sharedNeedle} dois`);
  try {
    await notion.editFounderFocusBodyItem(testPageId, sharedNeedle, "novo texto");
    check("ambiguous match throws instead of guessing", false, "did not throw");
  } catch (err) {
    check("ambiguous match throws instead of guessing", /várias/.test(err.message), err.message);
  }
  // Clean up the two ambiguous lines individually (now unambiguous with full text)
  await notion.editFounderFocusBodyItem(testPageId, `${sharedNeedle} um`, undefined);
  await notion.editFounderFocusBodyItem(testPageId, `${sharedNeedle} dois`, undefined);

  // Remove
  await notion.editFounderFocusBodyItem(testPageId, crossLine, undefined);
  try {
    await notion.editFounderFocusBodyItem(testPageId, crossLine, "não devia encontrar");
    check("removed line no longer findable", false, "still matched after removal");
  } catch {
    check("removed line no longer findable", true);
  }

  // Not-found
  try {
    await notion.editFounderFocusBodyItem(testPageId, `inexistente-${Date.now()}`, "x");
    check("not-found search throws", false, "did not throw");
  } catch (err) {
    check("not-found search throws", /não encontrei/.test(err.message), err.message);
  }

  console.log("");
  console.log(SEP);
  console.log("Summary");
  console.log(SEP);
  const passed = results.filter((r) => r.status === "pass").length;
  const failed = results.filter((r) => r.status === "fail").length;
  console.log(`  ${passed} passed, ${failed} failed`);

  process.exitCode = failed > 0 ? 1 : 0;
}

main()
  .catch((err) => {
    console.error("\n❌ UNEXPECTED FAILURE:", err.message);
    if (err.stack) console.error(err.stack);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (testPageId) {
      try {
        await notion.archivePage(testPageId);
        console.log(`\n✓ cleaned up test row (${testPageId.slice(0, 8)}...)`);
      } catch (err) {
        console.error(`\n⚠ CLEANUP FAILED — archive page ${testPageId} by hand: ${err.message}`);
        process.exitCode = 1;
      }
    }
  });
