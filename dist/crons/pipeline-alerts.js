import { alertKey, pruneStaleKeys } from "../lib/alert-dedup.js";
import { getTelegramId } from "../lib/founders.js";
import { log } from "../lib/log.js";
import { sendDM } from "../lib/telegram.js";
import { weekOfYear } from "../lib/week.js";
import { formatContentAlert } from "../messages/pipeline.js";
import * as notion from "../notion.js";
// Content-calendar alerts go to Madalena and Mafalda only — Beatriz opted out
// 2026-09-15.
const CONTENT_CALENDAR_RECIPIENTS = ["Madalena", "Mafalda"];
// In-process dedup: resets on restart but acceptable — same alert won't fire
// twice on the same day under normal operation.
const seen = new Set();
function todayLabel() {
    return new Date().toISOString().slice(0, 10);
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
    for (const founder of CONTENT_CALENDAR_RECIPIENTS) {
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
    // Prune entries whose scope doesn't match today — content_calendar is the
    // only remaining dedup scope since the partner/influencer stale alerts
    // (weekly-scoped) were removed 2026-09-15.
    for (const key of pruneStaleKeys(seen, week, today)) {
        seen.delete(key);
    }
    const counts = {
        content_calendar: await processContentCalendar(today),
    };
    log.info("pipeline_alerts.done", { week, ...counts });
}
