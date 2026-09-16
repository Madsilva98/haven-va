/**
 * Weekly cleanup of "Leads a contactar" — the founder's call: this DB
 * should only ever show people who genuinely still need a follow-up.
 *
 * 1. Any row marked Estado="Perdido" (the founder gave up on it) gets
 *    archived — she flips the status by hand in Notion, this is just the
 *    "next time the cron runs, tidy it away" half of that workflow.
 * 2. Any still-open row (Novo/Contactado) whose email now has a real
 *    purchase on file (src/lib/leads.ts hasRealPurchase — same check used
 *    before ever writing a lead) gets archived too: they converted, no
 *    follow-up needed, and marking them "Convertido" instead of archiving
 *    was tried and explicitly rejected by the founder — this DB is a to-do
 *    list, not a log.
 *
 * Channel-agnostic on purpose — works the same for Email, Intro Pack, and
 * (once unblocked) WhatsApp/Instagram leads, since "did they ever pay us"
 * doesn't depend on which channel originally surfaced them.
 */
import { hasRealPurchase } from "../lib/leads.js";
import { log } from "../lib/log.js";
import { isStudioSupabaseAvailable } from "../lib/studio-supabase.js";
import * as notion from "../notion.js";
function errMsg(err) {
    return err instanceof Error ? err.message : String(err);
}
export async function run() {
    if (!process.env.NOTION_LEADS_DB_ID) {
        log.debug("leads_reconcile.skipped", { reason: "NOTION_LEADS_DB_ID not set" });
        return;
    }
    let archivedLost = 0;
    try {
        const lost = await notion.getLeadsByEstado(["Perdido"]);
        for (const row of lost) {
            try {
                await notion.archivePage(row.id);
                archivedLost++;
            }
            catch (err) {
                log.error("leads_reconcile.archive_lost_failed", { pageId: row.id, message: errMsg(err) });
            }
        }
    }
    catch (err) {
        log.error("leads_reconcile.fetch_lost_failed", { message: errMsg(err) });
    }
    let archivedConverted = 0;
    if (isStudioSupabaseAvailable()) {
        try {
            const open = await notion.getLeadsByEstado(["Novo", "Contactado"]);
            for (const row of open) {
                if (!row.email)
                    continue;
                try {
                    if (await hasRealPurchase(row.email)) {
                        await notion.archivePage(row.id);
                        archivedConverted++;
                    }
                }
                catch (err) {
                    log.error("leads_reconcile.check_converted_failed", { pageId: row.id, message: errMsg(err) });
                }
            }
        }
        catch (err) {
            log.error("leads_reconcile.fetch_open_failed", { message: errMsg(err) });
        }
    }
    log.info("leads_reconcile.done", { archivedLost, archivedConverted });
}
