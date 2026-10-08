/**
 * Telegram MarkdownV2 message for the Monday competitor-movements cron.
 *
 * Founder's call (2026-10-08): key points only — the week's three BREAKS
 * that matter most (a competitor doing something new against its own strategy
 * or the industry), one line each, and a count of the rest with a link to the
 * dashboard's Competitors page, where everything is listed. The list is decided
 * in haven-comms (competitor_movements.py, from Instagram, websites and the
 * newsletters this bot records in Notion), each item scored `m` (matters to The
 * Haven, 1-5); this message only picks the top three of the week. It also warns
 * when the weekly analysis didn't run, so a silent gap (like 5 Oct 2026) can't
 * go unnoticed.
 */
import { escapeMd } from "./cycle.js";
export const COMPETITORS_PAGE_URL = "https://project-t33mk.vercel.app/competitors";
const TOP = 3;
const STALE_AFTER_DAYS = 6;
function daysBetween(from, to) {
    return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}
/**
 * International studios are inspiration only: they stay on the page but never reach the message
 * (founder's call, 2026-10-08). Hand-written items may lack `tier`; their `who` says "(international)".
 */
function isInternational(i) {
    return i.tier === "International" || /international/i.test(i.who ?? "");
}
/** Items the weekly analysis added in the 7 days up to `today`, most important first, international left out. */
export function thisWeeksMovements(items, today) {
    return items
        .filter((i) => i.wk && daysBetween(i.wk, today) >= 0 && daysBetween(i.wk, today) < 7)
        .filter((i) => !isInternational(i))
        .map((i, n) => ({ i, n }))
        .sort((a, b) => (b.i.m ?? 0) - (a.i.m ?? 0) || a.n - b.n)
        .map(({ i }) => i);
}
function mdLink(label, url) {
    return `[${escapeMd(label)}](${url.replace(/[)\\]/g, (m) => `\\${m}`)})`;
}
function warnings(args) {
    const out = [];
    const { status, today } = args;
    if (!status || daysBetween(status.date, today) > STALE_AFTER_DAYS) {
        out.push("⚠️ a análise semanal da concorrência não correu esta semana — a lista pode estar incompleta.");
    }
    else if (!status.ok) {
        const failed = ["instagram", "websites", "newsletters"].filter((s) => status[s] && !status[s].ok);
        const parts = failed.map((s) => ({ instagram: "Instagram", websites: "sites", newsletters: "newsletters" })[s]);
        if (status.failures.length)
            parts.push(`${status.failures.length} estúdio(s)`);
        out.push(`⚠️ a análise semanal correu com falhas (${parts.join(", ") || "ver status.json"}) — a lista pode estar incompleta.`);
    }
    if (args.intelErrors > 0) {
        out.push(`⚠️ ${args.intelErrors} newsletter(s) com erro — tentamos de novo na próxima segunda.`);
    }
    return out;
}
export function formatCompetitorMovements(args) {
    const week = thisWeeksMovements(args.innovations, args.today);
    const lines = ["*concorrência — semana*"];
    const warn = warnings(args);
    if (warn.length)
        lines.push(...warn.map(escapeMd));
    if (week.length === 0) {
        lines.push(escapeMd("nada fora do habitual esta semana."), mdLink("página Competitors", COMPETITORS_PAGE_URL));
        return lines.join("\n");
    }
    lines.push(...week.slice(0, TOP).map((i) => escapeMd(`• ${i.pt || `${i.who}: ${i.t}`}`)));
    const rest = week.length - TOP;
    lines.push(rest > 0 ? `${escapeMd(`+${rest} na`)} ${mdLink("página Competitors", COMPETITORS_PAGE_URL)}` : mdLink("página Competitors", COMPETITORS_PAGE_URL));
    return lines.join("\n");
}
