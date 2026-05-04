import { getTelegramId } from "../lib/founders.js";
import { log } from "../lib/log.js";
import { sendDM } from "../lib/telegram.js";
import { weekOfYear } from "../lib/week.js";
import { draftFollowup } from "../bot/draft-followup.js";
import {
  formatContentAlert,
  formatInfluencerAlert,
  formatPartnerAlert,
} from "../messages/pipeline.js";
import * as notion from "../notion.js";
import type { FounderName, InfluencerRow, PartnerRow } from "../types.js";

type AlertType =
  | "partner_no_response"
  | "partner_no_progress"
  | "influencer_no_response"
  | "influencer_no_progress"
  | "content_calendar";

// In-process dedup: resets on restart but acceptable — same alert won't fire
// multiple times within a week under normal operation.
const seen = new Set<string>();

function alertKey(rowId: string, type: AlertType, week: number): string {
  return `${rowId}|${type}|${week}`;
}

function daysSince(iso: string | null): number {
  if (!iso) return 0;
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return 0;
  return Math.max(0, Math.floor((Date.now() - then) / (1000 * 60 * 60 * 24)));
}

function isFounder(value: string): value is FounderName {
  return value === "Madalena" || value === "Mafalda" || value === "Beatriz";
}

async function notifyOwner(
  owner: string,
  text: string,
  context: Record<string, unknown>,
): Promise<void> {
  if (!isFounder(owner)) {
    log.debug("pipeline_alerts.skip_unassigned", context);
    return;
  }
  const tgId = getTelegramId(owner);
  if (tgId === null) {
    log.warn("pipeline_alerts.no_telegram_id", { owner, ...context });
    return;
  }
  try {
    await sendDM(tgId, text);
  } catch (err) {
    log.error("pipeline_alerts.dm_failed", {
      owner,
      message: err instanceof Error ? err.message : String(err),
      ...context,
    });
  }
}

async function processPartners(
  category: "no_response" | "no_progress",
  week: number,
): Promise<number> {
  const type: AlertType =
    category === "no_response" ? "partner_no_response" : "partner_no_progress";
  let rows: PartnerRow[] = [];
  try {
    rows = await notion.getPartnersStale(category);
  } catch (err) {
    log.warn("pipeline_alerts.partners_fetch_failed", {
      category,
      message: err instanceof Error ? err.message : String(err),
    });
    return 0;
  }
  let sent = 0;
  for (const row of rows) {
    const key = alertKey(row.id, type, week);
    if (seen.has(key)) continue;
    const days = daysSince(row.ultimoContacto);
    const draft = await draftFollowup("partner", row, days);
    const msg = formatPartnerAlert(row, days, draft);
    await notifyOwner(row.owner, msg, { rowId: row.id, type });
    seen.add(key);
    sent++;
  }
  return sent;
}

async function processInfluencers(
  category: "no_response" | "no_progress",
  week: number,
): Promise<number> {
  const type: AlertType =
    category === "no_response" ? "influencer_no_response" : "influencer_no_progress";
  let rows: InfluencerRow[] = [];
  try {
    rows = await notion.getInfluencersStale(category);
  } catch (err) {
    log.warn("pipeline_alerts.influencers_fetch_failed", {
      category,
      message: err instanceof Error ? err.message : String(err),
    });
    return 0;
  }
  let sent = 0;
  for (const row of rows) {
    const key = alertKey(row.id, type, week);
    if (seen.has(key)) continue;
    const days = daysSince(row.ultimoContacto);
    const draft = await draftFollowup("influencer", row, days);
    const msg = formatInfluencerAlert(row, days, draft);
    await notifyOwner(row.owner, msg, { rowId: row.id, type });
    seen.add(key);
    sent++;
  }
  return sent;
}

async function processContentCalendar(week: number): Promise<number> {
  let buckets: Awaited<ReturnType<typeof notion.getContentCalendarAlerts>>;
  try {
    buckets = await notion.getContentCalendarAlerts();
  } catch (err) {
    log.warn("pipeline_alerts.content_fetch_failed", {
      message: err instanceof Error ? err.message : String(err),
    });
    return 0;
  }
  const total =
    buckets.hours_to_publish_unscheduled.length +
    buckets.editing_too_long.length +
    buckets.ideation_stale.length;
  if (total === 0) return 0;

  const shape =
    `${buckets.hours_to_publish_unscheduled.length}-` +
    `${buckets.editing_too_long.length}-${buckets.ideation_stale.length}`;
  const key = alertKey(`content:${shape}`, "content_calendar", week);
  if (seen.has(key)) return 0;

  const text = formatContentAlert(buckets);
  await notifyOwner("Madalena", text, { type: "content_calendar" });
  seen.add(key);
  return 1;
}

export async function run(): Promise<void> {
  const week = weekOfYear();
  const counts = {
    partner_no_response: await processPartners("no_response", week),
    partner_no_progress: await processPartners("no_progress", week),
    influencer_no_response: await processInfluencers("no_response", week),
    influencer_no_progress: await processInfluencers("no_progress", week),
    content_calendar: await processContentCalendar(week),
  };
  log.info("pipeline_alerts.done", { week, ...counts });
}
