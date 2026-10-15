import fs from "node:fs";
import path from "node:path";
import { isEmptyPlan, planAmbassadorTierChanges, suspiciousReason } from "../lib/ambassador-tiers.js";
import { getTelegramId } from "../lib/founders.js";
import { log } from "../lib/log.js";
import { sendGroupMessageWithSource } from "../lib/pulse-source.js";
import { fetchAmbassadorTierMonthly, fetchDataAsOf, fetchMemberIdentity, PULSE_VIEW } from "../lib/pulse-views.js";
import { isStudioDbAvailable } from "../lib/studio-db.js";
import { sendDM, sendGroupMessage } from "../lib/telegram.js";
import { lisbonDateString } from "../lib/tz.js";
import { formatAmbassadorTierChanges, monthStartLabel } from "../messages/ambassador-tiers.js";
/**
 * The ambassador programme's monthly note to the group (Madalena, 2026-10-14/15):
 * once the count on the 1st is in, who moved up or down a tier, who is new and
 * whose discount stops, so Bia changes it in Kenko at their next payment.
 *
 * Decisions this reports on (Madalena, 2026-10-14/15; spec in haven-comms
 * docs/superpowers/specs/2026-10-14-b2b-one-pagers.md):
 * - Tier = referred people with an active membership on the 1st: 1 → 10%,
 *   2–3 → 15%, 4–5 → 50%, 6–10 → 2x por semana oferecida, 11+ → Ilimitado
 *   oferecido (thresholds changed 2026-10-15). The first five ambassadors get
 *   15% / 20% on tiers 1 and 2. All of it lives in
 *   va.v_pulse_ambassador_tier_monthly (`tier`, `discount_label`), never here.
 * - The new tier applies at the next payment, up or down, no grace month; the
 *   discount does not stack with any other (Bia applies the larger).
 * - Launched 2026-10-15; the first count is 2026-11-01, where everyone with a
 *   tier is "new".
 * - Silent when nothing changed (founder preference).
 *
 * Runs daily but posts once a month: only when data_as_of has reached the 1st
 * of the current month (the Kenko import is manual and can land days late — a
 * month row only exists in the view from then on) and that month has not been
 * posted. The posted month is saved BEFORE sending, so a crash cannot post
 * twice. If by the 5th the data still has not reached the 1st, one DM to
 * Madalena that the import is late.
 *
 * Safety: AMBASSADOR_TIERS_DRY_RUN=true logs the message and posts/saves
 * nothing. Circuit breaker (src/lib/ambassador-tiers.ts `suspiciousReason`):
 * more than half the tiered ambassadors moving, or no one tiered after a month
 * that had some → nothing posted, one warning to Madalena;
 * AMBASSADOR_TIERS_FORCE=true lets one such run through.
 *
 * State: DATA_DIR/ambassador-tiers-state.json. Schedule: 08:25 Europe/Lisbon
 * every day. Registered in src/server.ts. See docs/knowledge-base/ambassador-tiers.md.
 */
const DATA_DIR = process.env.DATA_DIR ?? ".";
const STATE_PATH = path.join(DATA_DIR, "ambassador-tiers-state.json");
const LATE_IMPORT_DAY = 5;
const EMPTY_STATE = { lastPostedMonth: null, lateWarnedMonth: null, suspiciousWarnedMonth: null };
function loadState() {
    try {
        return { ...EMPTY_STATE, ...JSON.parse(fs.readFileSync(STATE_PATH, "utf8")) };
    }
    catch {
        return { ...EMPTY_STATE };
    }
}
function saveState(state) {
    fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
    fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}
function errMsg(err) {
    return err instanceof Error ? err.message : String(err);
}
function isOn(envVar) {
    return process.env[envVar] === "true";
}
/** "2026-11-01" → "2026-10-01". */
export function previousMonthStart(monthStart) {
    const y = Number(monthStart.slice(0, 4));
    const m = Number(monthStart.slice(5, 7));
    return m === 1 ? `${y - 1}-12-01` : `${y}-${String(m - 1).padStart(2, "0")}-01`;
}
function ddmmyyyy(date) {
    const [y, m, d] = date.split("-");
    return `${d}/${m}/${y}`;
}
async function notifyMadalena(text) {
    try {
        const madalena = getTelegramId("Madalena");
        if (madalena !== null)
            await sendDM(madalena, text);
        else
            await sendGroupMessage(text);
    }
    catch (err) {
        log.error("cron.ambassador_tiers.notify_failed", { message: errMsg(err) });
    }
}
export async function run(now = new Date()) {
    if (!isStudioDbAvailable()) {
        log.debug("cron.ambassador_tiers.skipped", { reason: "studio_db_not_configured" });
        return;
    }
    const today = lisbonDateString(now);
    const monthStart = `${today.slice(0, 8)}01`;
    const state = loadState();
    const dryRun = isOn("AMBASSADOR_TIERS_DRY_RUN");
    if (state.lastPostedMonth !== null && state.lastPostedMonth >= monthStart)
        return;
    try {
        const asOf = await fetchDataAsOf();
        if (asOf === null || asOf < monthStart) {
            log.info("cron.ambassador_tiers.waiting_for_data", { monthStart, asOf });
            if (Number(today.slice(8)) >= LATE_IMPORT_DAY && state.lateWarnedMonth !== monthStart && !dryRun) {
                saveState({ ...state, lateWarnedMonth: monthStart });
                await notifyMadalena(`⚠️ Embaixadores: a importação do Kenko ainda não chegou a ${monthStartLabel(monthStart)} (dados até ${asOf ? ddmmyyyy(asOf) : "?"}). A contagem dos níveis sai no grupo assim que os dados chegarem a esse dia.`);
            }
            return;
        }
        const rows = await fetchAmbassadorTierMonthly(monthStart);
        const lastMonthStart = previousMonthStart(monthStart);
        const thisMonth = rows.filter((r) => r.month_start === monthStart);
        const lastMonth = rows.filter((r) => r.month_start === lastMonthStart);
        const earlier = rows.filter((r) => r.month_start < lastMonthStart);
        if (rows.length === 0) {
            // Before the first count (launch 2026-10-15 → first 1st is 2026-11-01).
            log.info("cron.ambassador_tiers.no_counts_yet", { monthStart, asOf });
            return;
        }
        const plan = planAmbassadorTierChanges(thisMonth, lastMonth, earlier);
        const counts = {
            monthStart,
            asOf,
            ambassadors: thisMonth.length,
            up: plan.up.length,
            down: plan.down.length,
            new: plan.new.length,
            left: plan.left.length,
            dryRun,
        };
        log.info("cron.ambassador_tiers.plan", counts);
        const reason = suspiciousReason(plan, thisMonth, lastMonth);
        if (reason && !isOn("AMBASSADOR_TIERS_FORCE")) {
            log.warn("cron.ambassador_tiers.suspicious", { ...counts, reason });
            if (state.suspiciousWarnedMonth !== monthStart && !dryRun) {
                saveState({ ...state, suspiciousWarnedMonth: monthStart });
                await notifyMadalena(`⚠️ Embaixadores: não publiquei a contagem de ${monthStartLabel(monthStart)} no grupo — ${reason} Parece um problema nos dados (importação do Kenko?). Vê com AMBASSADOR_TIERS_DRY_RUN=true; se estiver certo, corre uma vez com AMBASSADOR_TIERS_FORCE=true.`);
            }
            return;
        }
        if (isEmptyPlan(plan)) {
            log.info("cron.ambassador_tiers.no_changes", counts);
            if (!dryRun)
                saveState({ ...state, lastPostedMonth: monthStart });
            return;
        }
        const identity = await fetchMemberIdentity();
        const names = new Map(identity.filter((i) => i.contact_name).map((i) => [i.member_id, i.contact_name]));
        const message = formatAmbassadorTierChanges(plan, monthStart, names);
        if (!message)
            return;
        if (dryRun) {
            log.info("cron.ambassador_tiers.dry_run", { ...counts, message });
            return;
        }
        // Written before sending: a crash after this line can lose one post, never double it.
        saveState({ ...state, lastPostedMonth: monthStart });
        const messageId = await sendGroupMessageWithSource(message, [PULSE_VIEW.ambassadorTierMonthly], asOf);
        log.info("cron.ambassador_tiers.posted", { ...counts, messageId });
    }
    catch (err) {
        log.error("cron.ambassador_tiers.failed", { monthStart, message: errMsg(err) });
    }
}
