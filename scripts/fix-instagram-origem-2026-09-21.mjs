/**
 * One-off retroactive fix: the very first live run of
 * src/crons/leads-instagram-scan.ts (2026-09-21) wrote Meta's internal
 * numeric Instagram id into the Origem field whenever a contact had no
 * username — looks like it might be a usable handle, isn't (not
 * searchable/linkable). Fixed in the cron itself same day; this patches
 * the ~260 pages already created before that fix, using the checkpoint
 * file (data/instagram-leads-sync-state.json) as the authoritative list
 * of exactly which pages this run touched.
 *
 * Read-then-conditionally-write: only pages whose Origem still matches the
 * old "Instagram DM · <numeric-id> · N mensagens · contacto <uuid>"
 * pattern get patched — safe to re-run.
 *
 * Usage: node --env-file=.env.local scripts/fix-instagram-origem-2026-09-21.mjs [--apply]
 */

import fs from "node:fs";
import { Client } from "@notionhq/client";

const notion = new Client({ auth: process.env.NOTION_API_KEY, notionVersion: "2025-09-03" });

const STATE_PATH = process.env.STATE_PATH ?? "instagram-leads-sync-state.json";
// The old fallback wasn't always a raw numeric Meta id — for manual_upload
// (historical backfill) contacts, Mafalda's import tooling generated a
// synthetic id like "upload:Beca" (no real Instagram id exists for those).
// Match anything in the handle slot that ISN'T already a real "@handle" or
// the new "sem @" text.
const OLD_PATTERN = /^Instagram DM · ([^@].*?) · (\d+) mensagens · contacto ([0-9a-f-]+)$/;
const ALREADY_FIXED = "sem @ (só nome no Instagram)";

async function main() {
  const apply = process.argv.includes("--apply");
  const state = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));

  const pageIds = Object.values(state)
    .map((entry) => entry.notionPageId)
    .filter((id) => typeof id === "string");

  console.log(`${pageIds.length} pages in checkpoint to check.`);

  let patched = 0;
  let alreadyFine = 0;
  let failed = 0;

  for (const pageId of pageIds) {
    try {
      const page = await notion.pages.retrieve({ page_id: pageId });
      const origemProp = page.properties?.Origem;
      const text = origemProp?.rich_text?.map((t) => t.plain_text).join("") ?? "";
      const match = text.match(OLD_PATTERN);
      if (!match || match[1] === ALREADY_FIXED) {
        alreadyFine++;
        continue;
      }
      const [, , messageCount, contactId] = match;
      const newText = `Instagram DM · ${ALREADY_FIXED} · ${messageCount} mensagens · contacto ${contactId}`;

      if (!apply) {
        console.log(`[dry-run] ${pageId}: "${text}" -> "${newText}"`);
        patched++;
        continue;
      }

      await notion.pages.update({
        page_id: pageId,
        properties: {
          Origem: { rich_text: [{ text: { content: newText } }] },
        },
      });
      patched++;
    } catch (err) {
      console.error(`  fail — ${pageId}:`, err.body ?? err.message);
      failed++;
    }
  }

  console.log(`\n${patched} ${apply ? "patched" : "would be patched"}, ${alreadyFine} already fine, ${failed} failed.`);
  if (!apply) console.log("Re-run with --apply to actually write.");
}

main().catch((err) => {
  console.error("failed:", err.body ?? err.message);
  process.exit(1);
});
