import { alertKey, pruneStaleKeys } from "../lib/alert-dedup.js";
import { getTelegramId } from "../lib/founders.js";
import { log } from "../lib/log.js";
import { sendDM } from "../lib/telegram.js";
import { weekOfYear } from "../lib/week.js";
import { draftFollowup } from "../bot/draft-followup.js";
import { formatContentAlert, formatInfluencerAlert, formatPartnerAlert, } from "../messages/pipeline.js";
import * as notion from "../notion.js";
const FOUNDERS = ["Madalena", "Mafalda", "Beatriz"];
// In-process dedup: resets on restart but acceptable — same alert won't fire
// multiple times within a week (or day, for content_calendar) under normal
// operation.
const seen = new Set();
function todayLabel() {
    return new Date().toISOString().slice(0, 10);
}
function daysSince(iso) {
    if (!iso)
        return 0;
    const then = new Date(iso).getTime();
    if (!Number.isFinite(then))
        return 0;
    return Math.max(0, Math.floor((Date.now() - then) / (1000 * 60 * 60 * 24)));
}
function isFounder(value) {
    return value === "Madalena" || value === "Mafalda" || value === "Beatriz";
}
async function notifyOwner(owner, text, context) {
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
    }
    catch (err) {
        log.error("pipeline_alerts.dm_failed", {
            owner,
            message: err instanceof Error ? err.message : String(err),
            ...context,
        });
    }
}
async function processPartners(category, week) {
    const type = category === "no_response" ? "partner_no_response" : "partner_no_progress";
    let rows = [];
    try {
        rows = await notion.getPartnersStale(category);
    }
    catch (err) {
        log.warn("pipeline_alerts.partners_fetch_failed", {
            category,
            message: err instanceof Error ? err.message : String(err),
        });
        return 0;
    }
    let sent = 0;
    for (const row of rows) {
        const key = alertKey(row.id, type, week);
        if (seen.has(key))
            continue;
        const days = daysSince(row.ultimoContacto);
        const draft = await draftFollowup("partner", row, days);
        const msg = formatPartnerAlert(row, days, draft);
        await notifyOwner(row.owner, msg, { rowId: row.id, type });
        seen.add(key);
        sent++;
    }
    return sent;
}
async function processInfluencers(category, week) {
    const type = category === "no_response" ? "influencer_no_response" : "influencer_no_progress";
    let rows = [];
    try {
        rows = await notion.getInfluencersStale(category);
    }
    catch (err) {
        log.warn("pipeline_alerts.influencers_fetch_failed", {
            category,
            message: err instanceof Error ? err.message : String(err),
        });
        return 0;
    }
    let sent = 0;
    for (const row of rows) {
        const key = alertKey(row.id, type, week);
        if (seen.has(key))
            continue;
        const days = daysSince(row.ultimoContacto);
        const draft = await draftFollowup("influencer", row, days);
        const msg = formatInfluencerAlert(row, days, draft);
        await notifyOwner(row.owner, msg, { rowId: row.id, type });
        seen.add(key);
        sent++;
    }
    return sent;
}
async function processContentCalendar(today) {
    let rows;
    try {
        rows = await notion.getContentCalendarNeedsScheduling();
    }
    catch (err) {
        log.warn("pipeline_alerts.content_fetch_failed", {
            message: err instanceof Error ? err.message : String(err),
        });
        return 0;
    }
    const unseen = rows.filter((row) => !seen.has(alertKey(row.id, "content_calendar", today)));
    if (unseen.length === 0)
        return 0;
    const text = formatContentAlert(unseen);
    for (const founder of FOUNDERS) {
        await notifyOwner(founder, text, { type: "content_calendar" });
    }
    for (const row of unseen) {
        seen.add(alertKey(row.id, "content_calendar", today));
    }
    return unseen.length;
}
export async function run() {
    const week = weekOfYear();
    const today = todayLabel();
    // Prune entries whose scope matches neither the current week nor today
    // — covers both the weekly (partner/influencer) and daily
    // (content_calendar) dedup keys, preventing unbounded Set growth.
    for (const key of pruneStaleKeys(seen, week, today)) {
        seen.delete(key);
    }
    const counts = {
        partner_no_response: await processPartners("no_response", week),
        partner_no_progress: await processPartners("no_progress", week),
        influencer_no_response: await processInfluencers("no_response", week),
        influencer_no_progress: await processInfluencers("no_progress", week),
        content_calendar: await processContentCalendar(today),
    };
    log.info("pipeline_alerts.done", { week, ...counts });
}
