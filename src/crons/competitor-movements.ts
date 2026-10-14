/**
 * Monday 08:30 Lisbon: posts the week's competitor movements to the group.
 *
 * The list itself is built in haven-comms after the 04:00 scrape
 * (automation/scripts/competitor_movements.py): only breaks from a studio's
 * strategy or the industry, from Instagram, the monthly website diff and the
 * newsletters competitor-intel.ts recorded at 02:30. It lands in the month's
 * watch.json — the dashboard's Competitors page — and this cron reads the same
 * file, so the page and the message never disagree. Founder's call, 2026-10-08.
 *
 * Needs COMMS_READ_TOKEN (read-only, haven-comms contents); without it, no-ops.
 * COMPETITOR_INTEL_DRY_RUN=true logs the message instead of sending it.
 * See docs/knowledge-base/competitor-intel.md.
 */

import { readFileSync } from "node:fs";

import { LAST_RUN_PATH } from "./competitor-intel.js";
import { commsReadEnabled, fetchInnovations, fetchLatestMovementsStatus } from "../lib/comms-repo.js";
import { formatCompetitorMovements, thisWeeksMovements } from "../messages/competitor-movements.js";
import { sendGroupMessage } from "../lib/telegram.js";
import { lisbonDateString, nowInLisbon } from "../lib/tz.js";
import { log } from "../lib/log.js";

function lastIntelErrors(today: string): number {
  try {
    const last = JSON.parse(readFileSync(LAST_RUN_PATH, "utf8")) as { at: string; errors: number };
    return lisbonDateString(new Date(last.at)) === today ? last.errors : 0;
  } catch {
    return 0;
  }
}

export async function run(): Promise<void> {
  if (!commsReadEnabled()) {
    log.debug("competitor_movements.disabled", { reason: "COMMS_READ_TOKEN not set" });
    return;
  }
  const today = lisbonDateString(nowInLisbon());
  // The week can straddle two months (e.g. a run on the 1st): read both.
  const prev = new Date(`${today.slice(0, 7)}-01T00:00:00Z`);
  prev.setUTCMonth(prev.getUTCMonth() - 1);
  const months = [prev.toISOString().slice(0, 7), today.slice(0, 7)];
  const innovations = (await Promise.all(months.map(fetchInnovations))).flat();
  const status = await fetchLatestMovementsStatus();

  const text = formatCompetitorMovements({ today, innovations, status, intelErrors: lastIntelErrors(today) });
  const week = thisWeeksMovements(innovations, today).length;
  if (process.env.COMPETITOR_INTEL_DRY_RUN === "true") {
    log.info("cron.competitor_movements.dry_run", { week, statusDate: status?.date, text });
    return;
  }
  const messageId = await sendGroupMessage(text, "MarkdownV2");
  log.info("cron.competitor_movements.posted", { messageId, week, statusDate: status?.date, statusOk: status?.ok });
}
