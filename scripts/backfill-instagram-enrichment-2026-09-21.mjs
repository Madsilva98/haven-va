/**
 * One-off backfill: retroactively enriches the ~260+ partner/influencer
 * Instagram-DM pages created before src/crons/leads-instagram-scan.ts
 * grew Sobre/Deal/Log enrichment (2026-09-21). The live cron's re-enrich
 * path (reEnrichContact) alone would never catch these — the checkpoint's
 * messageCountSeen was already passively kept in sync for them (the main
 * loop bumps it even without enriching), so "new messages since last
 * time" never fires for a contact that was simply never enriched at all.
 *
 * Reads data/instagram-leads-sync-state.json (the live cron's checkpoint,
 * same STATE_PATH convention as scripts/fix-instagram-origem-2026-09-21.mjs),
 * filters to parceiro/influencer entries with a notionPageId, re-fetches
 * each contact's current transcript from Studio DB (same source the live
 * cron reads), and runs the same enrichment. Matches the live cron's own
 * rule of never enriching a "já contactado" cold-outreach thread (no
 * inbound reply — nothing to summarize about the other side): the
 * checkpoint alone can't tell these apart from a real "parceiro"
 * classification (both use the same string), so this re-checks
 * hasInboundMessage against the real transcript, exactly like the cron
 * does before classifying at all.
 *
 * Idempotent: checks each target section's existing children first and
 * skips if already non-empty, so a partial/interrupted run resumes
 * cleanly and this never overwrites a founder's manual edit.
 *
 * Usage:
 *   npm run build
 *   node --env-file=.env.local scripts/backfill-instagram-enrichment-2026-09-21.mjs [--apply]
 */

import fs from "node:fs";
import { Client } from "@notionhq/client";

import { buildTranscript, extractVolunteeredEmail, fetchInstagramContactsWithMessages, hasInboundMessage } from "../dist/lib/instagram-inbox.js";
import { fetchAllCustomerNames, fetchAllVisitHistory, findBestNameMatch, findVisitHistory } from "../dist/lib/leads.js";
import { enrichInfluencerFromTranscript, enrichPartnerFromTranscript } from "../dist/lib/lead-classifier.js";
import { appendToPageSection, replacePageSection } from "../dist/notion.js";

const notionClient = new Client({ auth: process.env.NOTION_API_KEY, notionVersion: "2025-09-03" });
const STATE_PATH = process.env.STATE_PATH ?? "instagram-leads-sync-state.json";

function formatDatePt(iso) {
  const [y, m, d] = iso.slice(0, 10).split("-");
  return `${d}/${m}/${y}`;
}

function dated(text) {
  return `[${formatDatePt(new Date().toISOString())}] ${text}`;
}

// Same normalization notion.ts's getOrCreateToggleId uses — kept local
// since it's not exported, matching this repo's convention of one-off
// scripts being self-contained rather than reaching into cron internals.
function normalizeSectionName(text) {
  return text
    .replace(/\p{Emoji}/gu, "")
    .replace(/[^\wàáâãéêíóôõúüç\s]/gi, "")
    .toLowerCase()
    .trim();
}

async function sectionHasContent(pageId, sectionName) {
  const blocks = await notionClient.blocks.children.list({ block_id: pageId, page_size: 100 });
  const queryNorm = normalizeSectionName(sectionName);
  for (const block of blocks.results) {
    if (!["heading_1", "heading_2", "heading_3"].includes(block.type)) continue;
    const hData = block[block.type];
    if (!hData.is_toggleable) continue;
    const blockNorm = normalizeSectionName((hData.rich_text ?? []).map((rt) => rt.plain_text ?? "").join(""));
    if (blockNorm.includes(queryNorm) || queryNorm.includes(blockNorm)) {
      const children = await notionClient.blocks.children.list({ block_id: block.id, page_size: 1 });
      return children.results.length > 0;
    }
  }
  return false; // toggle doesn't exist yet on this page — definitely empty
}

function formatKenkoLine(volunteeredEmail, name, customers, activity) {
  if (volunteeredEmail) {
    const history = findVisitHistory(volunteeredEmail, activity);
    if (history && history.visitCount > 0 && history.firstVisit && history.lastVisit) {
      return `Kenko: já visitou o estúdio — ${history.visitCount} visitas, primeira em ${formatDatePt(history.firstVisit)}, última em ${formatDatePt(history.lastVisit)}.`;
    }
    return "Kenko: sem histórico de visitas para este email.";
  }
  const fuzzy = findBestNameMatch(name, customers);
  if (fuzzy) return `Kenko: possível correspondência (nome semelhante a ${fuzzy.name}) — por confirmar manualmente.`;
  return "Kenko: sem correspondência.";
}

async function main() {
  const apply = process.argv.includes("--apply");
  const state = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
  const targets = Object.entries(state).filter(
    ([, entry]) =>
      entry.notionPageId && (entry.classification === "parceiro" || entry.classification === "influencer"),
  );
  console.log(`${targets.length} parceiro/influencer pages in checkpoint to check.\n`);

  const [contacts, customers, activity] = await Promise.all([
    fetchInstagramContactsWithMessages(),
    fetchAllCustomerNames(),
    fetchAllVisitHistory(),
  ]);
  const contactsById = new Map(contacts.map((c) => [c.id, c]));

  let enriched = 0;
  let alreadyFilled = 0;
  let skippedColdOutreach = 0;
  let skippedNoContact = 0;
  let failed = 0;

  for (const [contactId, entry] of targets) {
    const contact = contactsById.get(contactId);
    if (!contact) {
      skippedNoContact++;
      continue;
    }
    const transcript = buildTranscript(contact.messages);
    if (!transcript) {
      skippedNoContact++;
      continue;
    }
    const name = contact.displayName || contact.username || `Instagram ${contact.platformUserId}`;
    const pageId = entry.notionPageId;

    // The checkpoint stores "parceiro" for BOTH a real inbound proposal and
    // a cold-outreach thread the studio sent with no reply — the live cron
    // never enriches the latter (nothing to summarize about the other
    // side), so this must re-check the real transcript to tell them apart.
    if (entry.classification === "parceiro" && !hasInboundMessage(contact.messages)) {
      skippedColdOutreach++;
      continue;
    }

    try {
      if (entry.classification === "parceiro") {
        const [sobreFilled, dealFilled, logFilled] = await Promise.all([
          sectionHasContent(pageId, "Sobre o parceiro"),
          sectionHasContent(pageId, "Deal e proposta"),
          sectionHasContent(pageId, "Log"),
        ]);
        if (sobreFilled && dealFilled && logFilled) {
          alreadyFilled++;
          continue;
        }

        const enrichment = await enrichPartnerFromTranscript(transcript);
        if (!enrichment) {
          failed++;
          continue;
        }
        if (!apply) {
          console.log(`[dry-run parceiro] ${name} (${pageId})`);
          if (!sobreFilled && enrichment.sobre) console.log(`  Sobre o parceiro: ${enrichment.sobre}`);
          if (!dealFilled && enrichment.deal) console.log(`  Deal e proposta: ${enrichment.deal}`);
          if (!logFilled && enrichment.log) console.log(`  Log: ${dated(enrichment.log)}`);
          console.log();
          enriched++;
          continue;
        }
        if (!sobreFilled && enrichment.sobre) await replacePageSection(pageId, enrichment.sobre, "Sobre o parceiro");
        if (!dealFilled && enrichment.deal) await replacePageSection(pageId, enrichment.deal, "Deal e proposta");
        if (!logFilled && enrichment.log) await appendToPageSection(pageId, dated(enrichment.log), "Log");
        enriched++;
      } else {
        const [perfilFilled, logFilled] = await Promise.all([
          sectionHasContent(pageId, "Perfil e stats"),
          sectionHasContent(pageId, "Relação e histórico"),
        ]);
        if (perfilFilled && logFilled) {
          alreadyFilled++;
          continue;
        }

        const enrichment = await enrichInfluencerFromTranscript(transcript);
        const volunteeredEmail = extractVolunteeredEmail(contact.messages);
        const kenkoLine = formatKenkoLine(volunteeredEmail, name, customers, activity);
        const perfilStats = [enrichment?.sobre, kenkoLine].filter(Boolean).join("\n");
        if (!apply) {
          console.log(`[dry-run influencer] ${name} (${pageId})`);
          if (!perfilFilled && perfilStats) console.log(`  Perfil e stats: ${perfilStats}`);
          if (!logFilled && enrichment?.log) console.log(`  Relação e histórico: ${dated(enrichment.log)}`);
          console.log();
          enriched++;
          continue;
        }
        if (!perfilFilled && perfilStats) await replacePageSection(pageId, perfilStats, "Perfil e stats");
        if (!logFilled && enrichment?.log) await appendToPageSection(pageId, dated(enrichment.log), "Relação e histórico");
        enriched++;
      }
    } catch (err) {
      console.error(`  fail — ${pageId}:`, err.body ?? err.message);
      failed++;
    }
  }

  console.log(
    `\n${enriched} ${apply ? "enriched" : "would be enriched"}, ${alreadyFilled} already filled, ${skippedColdOutreach} skipped (cold outreach, no reply), ${skippedNoContact} skipped (no contact/transcript), ${failed} failed.`,
  );
  if (!apply) console.log("Re-run with --apply to actually write.");
}

main().catch((err) => {
  console.error("backfill failed:", err.body ?? err.message);
  process.exit(1);
});
