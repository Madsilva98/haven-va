/**
 * Weekly competitor-intel cron — two phases against the dedicated Gmail
 * account (yourhavenpilates@gmail.com):
 *
 *  1. Tidy: find Inbox messages from the founder-maintained sender list
 *     (Fontes Concorrência/Inspiração), tag them with the
 *     COMPETITOR_INTEL_LABEL and archive them.
 *  2. Process: extract findings from anything tagged-but-not-yet-processed
 *     (via the shared pipeline also used by the backfill script) and write
 *     them to the Competitor Intel Notion DB.
 *
 * Fully autonomous — no review gate before writing to Notion. Sends one
 * Telegram digest at the end either way, so founders know it ran even on a
 * quiet week. Gracefully no-ops if Gmail isn't authenticated or either
 * Notion DB id is unset, same as every other optional feature here.
 *
 * See docs/knowledge-base/competitor-intel.md.
 */

import * as gmail from "../lib/gmail.js";
import {
  competitorIntelLabel,
  isDryRun,
  processTaggedCompetitorEmails,
} from "../lib/competitor-intel-pipeline.js";
import { formatCompetitorIntelDigest } from "../messages/competitor-intel.js";
import { sendGroupMessage } from "../lib/telegram.js";
import { log } from "../lib/log.js";
import * as notion from "../notion.js";

export async function run(): Promise<void> {
  if (!process.env.NOTION_COMPETITOR_SOURCES_DB_ID || !process.env.NOTION_COMPETITOR_INTEL_DB_ID) {
    log.debug("competitor_intel.disabled", { reason: "Notion DB id(s) not set" });
    return;
  }
  if (!gmail.isAuthenticated()) {
    log.debug("competitor_intel.disabled", { reason: "gmail not authenticated — run /auth_gmail" });
    return;
  }

  const dryRun = isDryRun();

  // Phase 1: tidy.
  const sources = await notion.getActiveCompetitorSources();
  const senders = sources.map((s) => s.emailOuDominio).filter(Boolean);

  let tidiedCount = 0;
  if (senders.length === 0) {
    log.warn("competitor_intel.no_active_sources");
  } else {
    const labelId = await gmail.findLabelByName(competitorIntelLabel());
    if (!labelId) {
      log.error("competitor_intel.label_missing", { label: competitorIntelLabel() });
    } else {
      const inboxMatches = await gmail.listInboxMessagesFromSenders(senders);
      for (const msg of inboxMatches) {
        if (dryRun) {
          log.info("competitor_intel.would_tag_and_archive", {
            messageId: msg.id,
            from: msg.fromEmail,
            subject: msg.subject,
          });
        } else {
          await gmail.tagAndArchive(msg.id, labelId);
        }
        tidiedCount++;
      }
      log.info("competitor_intel.tidy_done", { dryRun, tidiedCount, sendersConfigured: senders.length });
    }
  }

  // Phase 2: process.
  const summary = await processTaggedCompetitorEmails();

  const text = formatCompetitorIntelDigest({ tidiedCount, summary });
  const messageId = await sendGroupMessage(text, "MarkdownV2");
  log.info("cron.competitor_intel.posted", {
    messageId,
    tidiedCount,
    messagesProcessed: summary.messagesProcessed,
    findingsWritten: summary.findingsWritten,
    errors: summary.errors,
  });
}
