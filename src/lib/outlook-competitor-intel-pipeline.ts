/**
 * Live competitor-intel pipeline as of the Outlook migration — reads a
 * dedicated Outlook shared mailbox (OUTLOOK_COMPETITOR_INTEL_MAILBOX) that
 * a founder manually resubscribes competitor/inspiration newsletters under,
 * extracts findings with Claude Haiku, and writes them to the Competitor
 * Intel Notion DB. See docs/knowledge-base/competitor-intel.md for why this
 * replaced the original Gmail design (src/lib/gmail.ts,
 * src/lib/competitor-intel-pipeline.ts, now kept only for a one-off backfill
 * of the pre-migration Gmail backlog).
 *
 * Single phase, unlike the Gmail version's tidy+process split — there's no
 * sender-matching "tidy" step here because the mailbox itself IS the
 * curated intake (nothing lands in it that isn't a deliberately-resubscribed
 * source). The Fontes DB (getActiveCompetitorSources) is not consulted by
 * this pipeline; it's the founder's own reference list of what she's
 * subscribed and how she's classified each one, not a filter the code reads.
 *
 * Still in Inbox IS the to-do queue, same trick tidy-mailboxes.ts uses:
 * archiving a message is what removes it from listInboxMessages' scope, so
 * there's no separate "already processed" state to maintain or that can
 * drift out of sync. The Outlook category applied alongside archiving is
 * purely a visual marker for a founder browsing the Archive folder later —
 * never read back by this pipeline — so a failure to apply it (logged, not
 * counted as an error) can never cause a message to be reprocessed or
 * skipped incorrectly.
 */

import * as outlook from "./outlook.js";
import { extractCompetitorIntel } from "./extract-competitor-intel.js";
import * as notion from "../notion.js";
import { log } from "./log.js";
import type { CompetitorIntelRunSummary } from "../types.js";

export const DEFAULT_PROCESSED_CATEGORY = "Competitor Intel: Processado";

export function competitorIntelMailbox(): string | null {
  return process.env.OUTLOOK_COMPETITOR_INTEL_MAILBOX || null;
}

export function competitorIntelProcessedCategory(): string {
  return process.env.OUTLOOK_COMPETITOR_INTEL_PROCESSED_CATEGORY ?? DEFAULT_PROCESSED_CATEGORY;
}

export function isDryRun(): boolean {
  return process.env.COMPETITOR_INTEL_DRY_RUN === "true";
}

function truncate(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

export async function processOutlookCompetitorIntel(): Promise<CompetitorIntelRunSummary> {
  const dryRun = isDryRun();
  const summary: CompetitorIntelRunSummary = {
    messagesSeen: 0,
    messagesProcessed: 0,
    findingsWritten: 0,
    errors: 0,
    byMessage: [],
  };

  const mailbox = competitorIntelMailbox();
  if (!mailbox) {
    log.debug("competitor_intel_outlook.disabled", { reason: "OUTLOOK_COMPETITOR_INTEL_MAILBOX not set" });
    return summary;
  }
  if (!outlook.isAuthenticated()) {
    log.debug("competitor_intel_outlook.disabled", { reason: "outlook not authenticated — run scripts/outlook-auth.mjs" });
    return summary;
  }

  const processedCategory = competitorIntelProcessedCategory();
  const messages = await outlook.listInboxMessages(mailbox);
  summary.messagesSeen = messages.length;

  for (const msg of messages) {
    let findings;
    try {
      findings = await extractCompetitorIntel({
        fromName: msg.from.name,
        fromEmail: msg.from.email,
        subject: msg.subject,
        body: msg.body,
      });
    } catch (err) {
      log.error("competitor_intel_outlook.extraction_failed", {
        messageId: msg.id,
        subject: msg.subject,
        message: err instanceof Error ? err.message : String(err),
      });
      summary.errors++;
      continue; // still in Inbox — retried next run
    }

    try {
      for (const finding of findings) {
        if (dryRun) {
          log.info("competitor_intel_outlook.would_write", {
            fonte: msg.from.name,
            tipo: finding.tipo,
            resumo: finding.resumo,
          });
          continue;
        }
        await notion.createCompetitorIntelFinding({
          nome: truncate(finding.resumo, 70),
          fonte: msg.from.name,
          tipos: [finding.tipo],
          resumo: finding.resumo,
          dataEmail: msg.receivedDateTime.slice(0, 10),
          assuntoEmail: msg.subject,
          link: msg.webLink,
        });
        summary.findingsWritten++;
      }
    } catch (err) {
      log.error("competitor_intel_outlook.notion_write_failed", {
        messageId: msg.id,
        subject: msg.subject,
        message: err instanceof Error ? err.message : String(err),
      });
      summary.errors++;
      continue; // partial write — still in Inbox, retried next run (may duplicate some findings)
    }

    summary.byMessage.push({
      fromName: msg.from.name,
      fromEmail: msg.from.email,
      subject: msg.subject,
      findings,
    });
    summary.messagesProcessed++;

    if (dryRun) {
      log.info("competitor_intel_outlook.would_categorize_and_archive", { messageId: msg.id, subject: msg.subject });
      continue;
    }

    // Archiving is what marks this message done — see module docstring.
    // Do it before the category tag so a category-tag failure never leaves
    // a message stuck un-archived (which WOULD cause reprocessing).
    await outlook.archiveMessage(mailbox, msg.id);
    try {
      await outlook.setMessageCategories(mailbox, msg.id, [...msg.categories, processedCategory]);
    } catch (err) {
      log.warn("competitor_intel_outlook.category_tag_failed", {
        messageId: msg.id,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  log.info("competitor_intel_outlook.process_done", {
    dryRun,
    messagesSeen: summary.messagesSeen,
    messagesProcessed: summary.messagesProcessed,
    findingsWritten: summary.findingsWritten,
    errors: summary.errors,
  });
  return summary;
}
