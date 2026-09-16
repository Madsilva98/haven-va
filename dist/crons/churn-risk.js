/**
 * Weekly churn-risk scan. Two parts:
 *
 * 1. Sweeps away any row the founder has closed out (Status="Resolvido"
 *    or "Arquivado") — she sets that by hand in Notion, this is the "next
 *    time the cron runs, tidy it away" half of that workflow. Same "stay
 *    alive" behaviour the founder asked for on Leads a contactar
 *    (src/crons/leads-reconcile.ts).
 * 2. Computes the 3 validated signals (src/lib/churn-signals.ts) against
 *    Studio Supabase, writes/updates "Clientes em risco" in Notion, and
 *    posts one digest to the Telegram group listing only who's newly
 *    flagged or gained a new signal this week. Rows already open from a
 *    prior week are the founder's manual follow-up, not re-nagged here.
 *
 * No-ops silently if STUDIO_SUPABASE_URL/KEY aren't configured, same as
 * the birthday cron.
 */
import { fetchChurnFlags } from "../lib/churn-signals.js";
import { log } from "../lib/log.js";
import { isStudioSupabaseAvailable } from "../lib/studio-supabase.js";
import { sendGroupMessage } from "../lib/telegram.js";
import { formatChurnDigest } from "../messages/churn.js";
import * as notion from "../notion.js";
function errMsg(err) {
    return err instanceof Error ? err.message : String(err);
}
export async function run() {
    if (!process.env.NOTION_CHURN_RISK_DB_ID) {
        log.debug("churn_risk.skipped", { reason: "NOTION_CHURN_RISK_DB_ID not set" });
        return;
    }
    if (!isStudioSupabaseAvailable()) {
        log.debug("churn_risk.skipped", { reason: "studio_supabase_not_configured" });
        return;
    }
    let archivedClosed = 0;
    try {
        const closed = await notion.getChurnRowsByStatus(["Resolvido", "Arquivado"]);
        for (const row of closed) {
            try {
                await notion.archivePage(row.id);
                archivedClosed++;
            }
            catch (err) {
                log.error("churn_risk.archive_closed_failed", { pageId: row.id, message: errMsg(err) });
            }
        }
    }
    catch (err) {
        log.error("churn_risk.fetch_closed_failed", { message: errMsg(err) });
    }
    let flags;
    try {
        flags = await fetchChurnFlags();
    }
    catch (err) {
        log.error("churn_risk.fetch_failed", { message: errMsg(err) });
        return;
    }
    const changed = [];
    for (const flag of flags) {
        const signalTypes = flag.signals.map((s) => s.type);
        const detalhes = flag.signals.map((s) => s.detail).join("; ");
        try {
            const existing = await notion.getChurnRowByEmail(flag.email);
            if (!existing) {
                await notion.createChurnFlag(flag.name, flag.email, signalTypes, detalhes, flag.plano, flag.telefone);
                changed.push({ nome: flag.name, sinais: signalTypes });
                continue;
            }
            const newSignals = signalTypes.filter((t) => !existing.sinais.includes(t));
            if (newSignals.length === 0)
                continue; // nothing new since last week
            const union = Array.from(new Set([...existing.sinais, ...signalTypes]));
            await notion.updateChurnFlag(existing.id, union, detalhes);
            changed.push({ nome: flag.name, sinais: newSignals });
        }
        catch (err) {
            log.error("churn_risk.write_failed", { email: flag.email, message: errMsg(err) });
        }
    }
    const message = formatChurnDigest(changed);
    if (!message) {
        log.info("churn_risk.no_changes", { totalFlagged: flags.length, archivedClosed });
        return;
    }
    try {
        const messageId = await sendGroupMessage(message);
        log.info("churn_risk.posted", { messageId, count: changed.length, archivedClosed });
    }
    catch (err) {
        log.error("churn_risk.send_failed", { message: errMsg(err) });
    }
}
