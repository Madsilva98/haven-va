import { getTelegramId } from "../lib/founders.js";
import { log } from "../lib/log.js";
import { sendDM, sendGroupMessage } from "../lib/telegram.js";
import { currentWeekLabel } from "../lib/week.js";
import { formatDailyMadalenaPlaceholder, formatMondayPriorities, } from "../messages/cycle.js";
import * as notion from "../notion.js";
const FOUNDERS = ["Madalena", "Mafalda", "Beatriz"];
export async function run() {
    const weekLabel = currentWeekLabel();
    const [priorities, focus] = await Promise.all([
        notion.getWeeklyPriorities(weekLabel),
        safeFounderFocus(weekLabel),
    ]);
    const prioritiesByFounder = {
        Madalena: [],
        Mafalda: [],
        Beatriz: [],
    };
    for (const t of priorities) {
        if (t.owner === "Madalena" ||
            t.owner === "Mafalda" ||
            t.owner === "Beatriz") {
            prioritiesByFounder[t.owner].push(t);
        }
    }
    const groupText = formatMondayPriorities({ weekLabel, prioritiesByFounder, focus });
    const groupMsgId = await sendGroupMessage(groupText, "MarkdownV2");
    let dmsSent = 0;
    for (const founder of FOUNDERS) {
        const tgId = getTelegramId(founder);
        if (tgId === null) {
            log.warn("cron.monday.no_telegram_id", { founder });
            continue;
        }
        const dmText = formatDailyMadalenaPlaceholder({ tasks: prioritiesByFounder[founder] });
        try {
            await sendDM(tgId, dmText, "MarkdownV2");
            dmsSent++;
        }
        catch (err) {
            log.warn("cron.monday.dm_failed", {
                founder,
                err: err instanceof Error ? err.message : String(err),
            });
        }
    }
    log.info("cron.monday_priorities.posted", {
        groupMsgId,
        dmsSent,
        priorities: priorities.length,
    });
}
async function safeFounderFocus(weekLabel) {
    try {
        return await notion.getFounderFocusForWeek(weekLabel);
    }
    catch (err) {
        log.warn("cron.monday_priorities.focus_unavailable", {
            err: err instanceof Error ? err.message : String(err),
        });
        return [];
    }
}
