/**
 * GMAIL-ONLY, ONE-OFF-BACKFILL-ONLY as of the Outlook migration — see
 * docs/knowledge-base/competitor-intel.md. The live weekly cron
 * (src/crons/competitor-intel.ts) now reads a dedicated Outlook shared
 * mailbox via src/lib/outlook-competitor-intel-pipeline.ts instead, because
 * Gmail's `gmail.modify` scope is a Google "restricted" scope: unverified
 * apps in Testing publishing status get a 7-day refresh-token expiry, which
 * breaks an unattended weekly cron, and full verification/CASA assessment
 * wasn't worth it for a single-tenant internal tool. This module is kept
 * exactly as it was — still a real, working implementation — purely so
 * scripts/backfill-competitor-intel.mjs can do one last run against the
 * already-"email marketing concorrência"-tagged Gmail backlog.
 *
 * A message only gets the "processado" label once extraction AND every
 * Notion write for it succeeded — an error leaves it unlabelled so it's
 * retried on the next run instead of silently dropped.
 */

import * as gmail from "./gmail.js";
import { extractCompetitorIntel, type CompetitorIntelExtraction } from "./extract-competitor-intel.js";
import * as notion from "../notion.js";
import { log } from "./log.js";
import type { CompetitorIntelRunSummary } from "../types.js";

export const DEFAULT_LABEL = "email marketing concorrência";
export const DEFAULT_PROCESSED_LABEL = "email marketing concorrência: processado";

export function competitorIntelLabel(): string {
  return process.env.COMPETITOR_INTEL_LABEL ?? DEFAULT_LABEL;
}

export function competitorIntelProcessedLabel(): string {
  return process.env.COMPETITOR_INTEL_PROCESSED_LABEL ?? DEFAULT_PROCESSED_LABEL;
}

export function isDryRun(): boolean {
  return process.env.COMPETITOR_INTEL_DRY_RUN === "true";
}

export type { CompetitorIntelRunSummary };

function truncate(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

export async function processTaggedCompetitorEmails(): Promise<CompetitorIntelRunSummary> {
  const dryRun = isDryRun();
  const summary: CompetitorIntelRunSummary = {
    messagesSeen: 0,
    messagesProcessed: 0,
    findingsWritten: 0,
    errors: 0,
    byMessage: [],
  };

  const processedLabelId = dryRun
    ? await gmail.findLabelByName(competitorIntelProcessedLabel())
    : await gmail.getOrCreateLabel(competitorIntelProcessedLabel());
  if (!processedLabelId && !dryRun) {
    log.error("competitor_intel.processed_label_unavailable");
    return summary;
  }

  const messages = await gmail.listMessagesByLabel(
    competitorIntelLabel(),
    competitorIntelProcessedLabel(),
  );
  summary.messagesSeen = messages.length;

  for (const msg of messages) {
    let findings: CompetitorIntelExtraction[];
    try {
      findings = await extractCompetitorIntel({
        fromName: msg.fromName,
        fromEmail: msg.fromEmail,
        subject: msg.subject,
        body: msg.body,
      });
    } catch (err) {
      log.error("competitor_intel.extraction_failed", {
        messageId: msg.id,
        subject: msg.subject,
        message: err instanceof Error ? err.message : String(err),
      });
      summary.errors++;
      continue; // no "processado" label — retried next run
    }

    try {
      for (const finding of findings) {
        if (dryRun) {
          log.info("competitor_intel.would_write", {
            fonte: msg.fromName,
            tipo: finding.tipo,
            resumo: finding.resumo,
          });
          continue;
        }
        await notion.createCompetitorIntelFinding({
          nome: truncate(finding.resumo, 70),
          fonte: msg.fromName,
          tipos: [finding.tipo],
          resumo: finding.resumo,
          dataEmail: msg.date.slice(0, 10),
          assuntoEmail: msg.subject,
          link: msg.webLink,
        });
        summary.findingsWritten++;
      }
    } catch (err) {
      log.error("competitor_intel.notion_write_failed", {
        messageId: msg.id,
        subject: msg.subject,
        message: err instanceof Error ? err.message : String(err),
      });
      summary.errors++;
      continue; // partial write — leave unlabelled, retried next run (may duplicate some findings)
    }

    summary.byMessage.push({
      fromName: msg.fromName,
      fromEmail: msg.fromEmail,
      subject: msg.subject,
      findings,
    });
    summary.messagesProcessed++;

    if (dryRun) {
      log.info("competitor_intel.would_label_processado", { messageId: msg.id, subject: msg.subject });
    } else if (processedLabelId) {
      await gmail.applyLabel(msg.id, processedLabelId);
    }
  }

  log.info("competitor_intel.process_done", {
    dryRun,
    messagesSeen: summary.messagesSeen,
    messagesProcessed: summary.messagesProcessed,
    findingsWritten: summary.findingsWritten,
    errors: summary.errors,
  });
  return summary;
}
