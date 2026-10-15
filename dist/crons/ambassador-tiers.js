import fs from "node:fs";
import path from "node:path";
import { isEmptyPlan, planAmbassadorTierChanges, suspiciousReason } from "../lib/ambassador-tiers.js";
import { buildSnapshot, effectIfScheduledLeave, effectOnNextCount, isAtRisk, nextCountLabel, planAmbassadorNews, suspiciousImportReason, tierInForce, tierToday, CANCEL_SCHEDULED, } from "../lib/ambassador-watch.js";
import { getTelegramId } from "../lib/founders.js";
import { log } from "../lib/log.js";
import { sendGroupMessageWithSource } from "../lib/pulse-source.js";
import { fetchAmbassadorReferrals, fetchAmbassadorTierMonthly, fetchAmbassadorTierScale, fetchAmbassadorTierToday, fetchDataAsOf, fetchMemberIdentity, fetchMembershipStatusAsOf, PULSE_VIEW, } from "../lib/pulse-views.js";
import { isStudioDbAvailable } from "../lib/studio-db.js";
import { sendDM, sendGroupMessage } from "../lib/telegram.js";
import { lisbonDateString } from "../lib/tz.js";
import { formatAmbassadorMessage, monthStartLabel } from "../messages/ambassador-tiers.js";
import * as notion from "../notion.js";
/**
 * The ambassador programme, watched on every Kenko import (Madalena, 2026-10-14/15).
 *
 * Decisions (Madalena, 2026-10-14/15; programme spec in haven-comms
 * docs/superpowers/specs/2026-10-14-b2b-one-pagers.md, this cron's design
 * agreed in a grilling session on 2026-10-15):
 * - Tier = referred people with an active membership on the 1st: 1 → 10%,
 *   2–3 → 15%, 4–5 → 50%, 6–10 → 2x por semana oferecida, 11+ → Ilimitado
 *   oferecido; the first five get 15% / 20% on tiers 1–2. All of it lives in
 *   the views (v_pulse_ambassador_tier_monthly / _today / _scale), never here.
 * - The new tier applies at the next payment, up or down, no grace month; the
 *   discount doesn't stack (the larger one applies). Any founder applies it.
 * - A pause is not leaving; only a cancelled or expired membership is. That
 *   rule is the studio's (requested 2026-10-15,
 *   Haven-Comms docs/PROMPT-ambassador-pause-and-discount-haven-studio.md);
 *   until it lands, a paused referral stops counting and shows as
 *   "saiu (em pausa)".
 * - A failed payment is not leaving (Kenko keeps the membership Active).
 *
 * Each morning, when data_as_of has moved (a new Kenko import), one group
 * message with:
 * - "O que mudou": per ambassador, who started counting, who scheduled a
 *   cancellation, who left (and why), with the effect on the next count —
 *   every time, even when the tier doesn't change; plus an ambassador's own
 *   membership cancelled or ended when they have someone counting.
 * - "Contagem de 1 de …": on the first import that covers the 1st, who moved
 *   tier (src/lib/ambassador-tiers.ts).
 * - "A fazer": who to tell, which discount to change in Kenko.
 * Silent when there is nothing new. The first import ever seen is a baseline
 * (no "entrou" for everyone already counting).
 *
 * Also refreshes the "Embaixadores" Notion list (NOTION_AMBASSADORS_DB_ID),
 * one row per ambassador; "Avisada" is never written, "Desconto no Kenko" only
 * once the studio view carries it.
 *
 * State (DATA_DIR/ambassador-tiers-state.json): the last import seen, its
 * snapshot, the last month counted — saved BEFORE sending, so a crash can't
 * post twice. From the 5th with the data still short of the 1st: one DM to
 * Madalena that the Kenko import is late.
 *
 * Safety: AMBASSADOR_TIERS_DRY_RUN=true logs the message and the Notion rows,
 * posts and writes nothing (its own state file, ambassador-tiers-state.dry-run.json,
 * so each dry run diffs against the previous dry run). Circuit breaker: over half the people counting leaving in one
 * import, more than half the tiered ambassadors moving on the 1st, or no one
 * tiered after a month that had some → nothing posted or written, one DM;
 * AMBASSADOR_TIERS_FORCE=true lets one such run through.
 *
 * Schedule: 08:25 Europe/Lisbon every day. Registered in src/server.ts.
 * See docs/knowledge-base/ambassador-tiers.md.
 */
const DATA_DIR = process.env.DATA_DIR ?? ".";
// A dry run keeps its own state, so successive dry runs show real diffs without touching the live one.
function statePath(dryRun) {
    return path.join(DATA_DIR, dryRun ? "ambassador-tiers-state.dry-run.json" : "ambassador-tiers-state.json");
}
const LATE_IMPORT_DAY = 5;
const EMPTY_STATE = {
    lastAsOf: null,
    snapshot: null,
    lastPostedMonth: null,
    lateWarnedMonth: null,
    suspiciousWarnedAsOf: null,
};
function loadState(dryRun) {
    try {
        return { ...EMPTY_STATE, ...JSON.parse(fs.readFileSync(statePath(dryRun), "utf8")) };
    }
    catch {
        return { ...EMPTY_STATE };
    }
}
function saveState(state, dryRun = false) {
    const file = statePath(dryRun);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(state, null, 2));
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
    return `${date.slice(8, 10)}/${date.slice(5, 7)}/${date.slice(0, 4)}`;
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
const EXCLUDED = {
    self_referral: "não conta: auto-referência",
    several_ambassadors: "não conta: referida por mais de uma pessoa",
    no_purchase: "ainda sem compra",
    before_launch: "não conta: antes do lançamento",
    not_new: "não conta: já era cliente",
    no_membership: "ainda sem membership",
};
/** "Rita Costa — conta" lines for the Notion list, counting people first. */
export function referredSummary(referrals, statuses, names) {
    const lines = referrals.map((r) => {
        const name = names.get(r.referred_member_id) ?? `sem nome (${r.referred_member_id.slice(0, 8)})`;
        const st = statuses.get(r.referred_member_id);
        let what;
        if (r.excluded_reason)
            what = EXCLUDED[r.excluded_reason] ?? `não conta: ${r.excluded_reason}`;
        else if (r.active_on_data_as_of)
            what = st?.covers && st.status === CANCEL_SCHEDULED ? "conta, cancelamento agendado" : "conta";
        else if (st?.covers && st.status === "Paused")
            what = "em pausa";
        else if (st && !st.covers && st.status === "Canceled")
            what = "cancelou";
        else if (st && !st.covers && st.status === "Expired")
            what = "membership expirou";
        else
            what = "sem membership ativa";
        return { counts: what.startsWith("conta"), line: `${name} — ${what}` };
    });
    return lines
        .sort((a, b) => (a.counts === b.counts ? a.line.localeCompare(b.line, "pt") : a.counts ? -1 : 1))
        .map((l) => l.line)
        .join("\n");
}
function monthlyPart(rows, monthStart, asOf, lastPosted) {
    if (asOf < monthStart || (lastPosted !== null && lastPosted >= monthStart))
        return null;
    if (rows.length === 0)
        return null; // before the first count (2026-11-01)
    const lastMonthStart = previousMonthStart(monthStart);
    const thisMonth = rows.filter((r) => r.month_start === monthStart);
    const lastMonth = rows.filter((r) => r.month_start === lastMonthStart);
    const earlier = rows.filter((r) => r.month_start < lastMonthStart);
    const plan = planAmbassadorTierChanges(thisMonth, lastMonth, earlier);
    return { monthStart, plan, suspicious: suspiciousReason(plan, thisMonth, lastMonth) };
}
async function syncNotion(snapshot, referrals, statuses, monthly, today, names, asOf, dryRun) {
    if (!process.env.NOTION_AMBASSADORS_DB_ID)
        return;
    const existing = new Map((await notion.getAllAmbassadorRows()).map((r) => [r.memberId, r]));
    for (const [id, a] of Object.entries(snapshot)) {
        const inForce = tierInForce(monthly, id);
        const inForceCount = monthly.filter((r) => r.ambassador_member_id === id).sort((x, y) => (x.month_start < y.month_start ? 1 : -1))[0]
            ?.active_referred ?? 0;
        const todayTier = tierToday(today, id);
        const todayRow = today?.find((r) => r.ambassador_member_id === id);
        const fields = {
            pessoasAtivas: a.counting.length,
            nivelHoje: todayTier?.tier ?? null,
            descontoEmVigor: inForce.label,
            descontoHoje: todayTier?.label ?? null,
            emRisco: isAtRisk(a, inForce, todayTier, inForceCount),
            pessoasReferidas: referredSummary(referrals.filter((r) => r.ambassador_member_id === id), statuses, names),
            atualizadoEm: asOf,
            ...(todayRow && "discount_in_kenko" in todayRow && todayRow.discount_in_kenko !== null
                ? { descontoNoKenko: todayRow.discount_in_kenko ?? null }
                : {}),
        };
        const name = names.get(id) ?? `sem nome (${id.slice(0, 8)})`;
        if (dryRun) {
            log.info("cron.ambassador_tiers.dry_run_notion", { name, fields });
            continue;
        }
        try {
            const row = existing.get(id);
            if (row)
                await notion.updateAmbassadorRow(row.id, name, fields);
            else
                await notion.createAmbassadorRow(name, id, fields);
        }
        catch (err) {
            log.error("cron.ambassador_tiers.notion_failed", { memberId: id, message: errMsg(err) });
        }
    }
}
export async function run(now = new Date()) {
    if (!isStudioDbAvailable()) {
        log.debug("cron.ambassador_tiers.skipped", { reason: "studio_db_not_configured" });
        return;
    }
    const todayDate = lisbonDateString(now);
    const monthStart = `${todayDate.slice(0, 8)}01`;
    const dryRun = isOn("AMBASSADOR_TIERS_DRY_RUN");
    const state = loadState(dryRun);
    try {
        const asOf = await fetchDataAsOf();
        if (asOf === null)
            return;
        if (asOf < monthStart && Number(todayDate.slice(8)) >= LATE_IMPORT_DAY && state.lateWarnedMonth !== monthStart && !dryRun) {
            saveState({ ...state, lateWarnedMonth: monthStart });
            state.lateWarnedMonth = monthStart;
            await notifyMadalena(`⚠️ Embaixadores: a importação do Kenko ainda não chegou a ${monthStartLabel(monthStart)} (dados até ${ddmmyyyy(asOf)}). A contagem dos níveis sai no grupo assim que os dados chegarem a esse dia.`);
        }
        if (asOf === state.lastAsOf)
            return;
        const [referrals, monthly, today, scale, identity] = await Promise.all([
            fetchAmbassadorReferrals(),
            fetchAmbassadorTierMonthly(monthStart),
            fetchAmbassadorTierToday(),
            fetchAmbassadorTierScale(),
            fetchMemberIdentity(),
        ]);
        const ids = [...new Set(referrals.flatMap((r) => [r.ambassador_member_id, r.referred_member_id]))];
        const statuses = new Map((await fetchMembershipStatusAsOf(asOf, ids)).map((s) => [s.member_id, s]));
        const names = new Map(identity.filter((i) => i.contact_name).map((i) => [i.member_id, i.contact_name]));
        const snapshot = buildSnapshot(referrals, statuses);
        const news = planAmbassadorNews(state.snapshot, snapshot, statuses);
        const month = monthlyPart(monthly, monthStart, asOf, state.lastPostedMonth);
        const counts = {
            asOf,
            ambassadors: Object.keys(snapshot).length,
            counting: Object.values(snapshot).reduce((n, a) => n + a.counting.length, 0),
            news: news.length,
            monthly: month ? month.monthStart : null,
            todayView: today !== null,
            scaleView: scale !== null,
            dryRun,
        };
        log.info("cron.ambassador_tiers.plan", counts);
        const suspicious = [suspiciousImportReason(state.snapshot, news), month?.suspicious ?? null].filter(Boolean);
        if (suspicious.length > 0 && !isOn("AMBASSADOR_TIERS_FORCE")) {
            log.warn("cron.ambassador_tiers.suspicious", { ...counts, reasons: suspicious });
            if (state.suspiciousWarnedAsOf !== asOf && !dryRun) {
                saveState({ ...state, suspiciousWarnedAsOf: asOf });
                await notifyMadalena(`⚠️ Embaixadores: não publiquei nada sobre o import com dados até ${ddmmyyyy(asOf)} — ${suspicious.join(" ")} Parece um problema nos dados (importação do Kenko?). Vê com AMBASSADOR_TIERS_DRY_RUN=true; se estiver certo, corre uma vez com AMBASSADOR_TIERS_FORCE=true.`);
            }
            return;
        }
        const lines = news.map((n) => {
            const isFirstFive = today?.find((r) => r.ambassador_member_id === n.ambassadorId)?.is_first_five ?? false;
            const todayTier = tierToday(today, n.ambassadorId);
            return {
                news: n,
                effect: effectOnNextCount(tierInForce(monthly, n.ambassadorId), todayTier, asOf),
                scheduledEffect: effectIfScheduledLeave(scale, todayTier, n.countNow, n.cancelScheduled.length, isFirstFive),
                nextCount: nextCountLabel(asOf),
            };
        });
        const showMonthly = month && !isEmptyPlan(month.plan) ? { plan: month.plan, monthStart: month.monthStart } : null;
        const message = formatAmbassadorMessage({ asOf, news: lines, monthly: showMonthly, names });
        await syncNotion(snapshot, referrals, statuses, monthly, today, names, asOf, dryRun);
        if (dryRun) {
            log.info("cron.ambassador_tiers.dry_run", { ...counts, message });
            saveState({ ...state, lastAsOf: asOf, snapshot, lastPostedMonth: month ? month.monthStart : state.lastPostedMonth }, true);
            return;
        }
        // Saved before sending: a crash after this line can lose one post, never double it.
        saveState({
            ...state,
            lastAsOf: asOf,
            snapshot,
            lastPostedMonth: month ? month.monthStart : state.lastPostedMonth,
        });
        if (!message) {
            log.info("cron.ambassador_tiers.nothing_new", counts);
            return;
        }
        const views = [PULSE_VIEW.ambassadorReferrals, ...(showMonthly ? [PULSE_VIEW.ambassadorTierMonthly] : [])];
        const messageId = await sendGroupMessageWithSource(message, views, asOf);
        log.info("cron.ambassador_tiers.posted", { ...counts, messageId });
    }
    catch (err) {
        log.error("cron.ambassador_tiers.failed", { monthStart, message: errMsg(err) });
    }
}
