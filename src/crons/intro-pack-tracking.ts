/**
 * Daily: keeps the "Tracking intro packs" Notion list in step with
 * va.v_pulse_intro_pack_tracking and tells the group who joined it and who
 * converted. Every rule (who, why, when they leave) lives in that view —
 * see scripts/studio-db-intro-pack-tracking-2026-10-02.sql and
 * src/lib/intro-pack-tracking.ts for what this does with its answer.
 *
 * Replaces intro-pack-expiring.ts's digest once NOTION_INTRO_TRACKING_DB_ID
 * is set (src/server.ts picks one of the two at 08:15) — set it only after
 * the view exists in the studio database.
 *
 * Schedule: 08:15 Europe/Lisbon every day. Registered in src/server.ts.
 */

import { fetchAllCustomerNames } from "../lib/leads.js";
import { planIntroTracking, type Person, type TrackingCreate } from "../lib/intro-pack-tracking.js";
import { log } from "../lib/log.js";
import { sendGroupMessageWithSource } from "../lib/pulse-source.js";
import { fetchDataAsOf, fetchIntroPackTracking, memberIdFromEmail, PULSE_VIEW } from "../lib/pulse-views.js";
import { isStudioDbAvailable } from "../lib/studio-db.js";
import { formatIntroTrackingDigest } from "../messages/intro-pack-tracking.js";
import * as notion from "../notion.js";

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function run(): Promise<void> {
  if (!process.env.NOTION_INTRO_TRACKING_DB_ID) {
    log.debug("intro_pack_tracking.skipped", { reason: "NOTION_INTRO_TRACKING_DB_ID not set" });
    return;
  }
  if (!isStudioDbAvailable()) {
    log.debug("intro_pack_tracking.skipped", { reason: "studio_db_not_configured" });
    return;
  }

  let plan: ReturnType<typeof planIntroTracking>;
  let asOf: string | null;
  try {
    const [viewRows, notionRows, customers, dataAsOf] = await Promise.all([
      fetchIntroPackTracking(),
      notion.getAllIntroTrackingRows(),
      fetchAllCustomerNames(),
      fetchDataAsOf(),
    ]);
    asOf = dataAsOf;
    const people = new Map<string, Person>();
    for (const c of customers) {
      if (c.email) people.set(memberIdFromEmail(c.email), { name: c.name, phone: c.phone });
    }
    plan = planIntroTracking(viewRows, notionRows, people);
  } catch (err) {
    log.error("intro_pack_tracking.fetch_failed", { message: errMsg(err) });
    return;
  }

  const created: TrackingCreate[] = [];
  for (const c of plan.creates) {
    try {
      await notion.createIntroTrackingRow(c.name, c.memberId, c.fields);
      created.push(c);
    } catch (err) {
      log.error("intro_pack_tracking.create_failed", { memberId: c.memberId, message: errMsg(err) });
    }
  }

  const converted: string[] = [];
  for (const u of plan.updates) {
    try {
      await notion.updateIntroTrackingRow(u.pageId, u.fields, u.estado);
      if (u.estado === "Convertido") converted.push(u.name);
    } catch (err) {
      log.error("intro_pack_tracking.update_failed", { pageId: u.pageId, message: errMsg(err) });
    }
  }

  log.info("intro_pack_tracking.synced", {
    asOf,
    created: created.length,
    updated: plan.updates.length,
    converted: converted.length,
  });

  const message = formatIntroTrackingDigest(created, converted);
  if (!message) return;
  try {
    const messageId = await sendGroupMessageWithSource(message, [PULSE_VIEW.introPackTracking], asOf);
    log.info("intro_pack_tracking.posted", { messageId });
  } catch (err) {
    log.error("intro_pack_tracking.send_failed", { message: errMsg(err) });
  }
}
