/**
 * Weekly cleanup of "Leads a contactar" — the founder's call: this DB
 * should only ever show people who genuinely still need a follow-up. She
 * wants the list "viva" (alive) — whatever she sets Estado to by hand,
 * the next cron pass tidies away.
 *
 * 1. Any row marked Estado="Perdido" OR Estado="Convertido" gets archived
 *    unconditionally — those are both closed states the founder sets by
 *    hand in Notion, this is just the "next time the cron runs, tidy it
 *    away" half of that workflow. (Convertido is never the bot's own
 *    write — see point 2 — only ever a manual override, but once it's set
 *    the row shouldn't stick around either.)
 * 2. Any still-open row (Novo/Contactado) that has genuinely converted
 *    gets archived too — automatically, without the founder having to
 *    notice and flip the status herself. The bot marking it "Convertido"
 *    instead of archiving directly was tried and explicitly rejected by
 *    the founder — this DB is a to-do list, not a log.
 *
 * "Converted" is channel-dependent, which is why this can't just be one
 * hasRealPurchase(email) check for every open row:
 *   - Email/WhatsApp/Instagram leads never purchased anything before being
 *     written here, so ANY real purchase on file (src/lib/leads.ts
 *     hasRealPurchase) means they converted.
 *   - Intro Pack leads are people who ALREADY paid for their intro pack —
 *     that's how they ended up in this DB in the first place. Running
 *     hasRealPurchase on them is always true and would archive every one
 *     of them regardless of whether they ever came back (this happened in
 *     production on 2026-09-16 and had to be manually reverted). What
 *     "converted" means for them is the same question
 *     src/lib/intro-pack-conversion.ts asks when first writing the lead:
 *     did they start a subscription/non-intro membership AFTER their own
 *     pack's expiry date (src/lib/intro-pack-conversion.ts hasConvertedAfter).
 */
import { hasConvertedAfter, loadConversionCheckData } from "../lib/intro-pack-conversion.js";
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
    let archivedClosed = 0;
    try {
        const closed = await notion.getLeadsByEstado(["Perdido", "Convertido"]);
        for (const row of closed) {
            try {
                await notion.archivePage(row.id);
                archivedClosed++;
            }
            catch (err) {
                log.error("leads_reconcile.archive_closed_failed", { pageId: row.id, message: errMsg(err) });
            }
        }
    }
    catch (err) {
        log.error("leads_reconcile.fetch_closed_failed", { message: errMsg(err) });
    }
    let archivedConverted = 0;
    if (isStudioSupabaseAvailable()) {
        try {
            const open = await notion.getLeadsByEstado(["Novo", "Contactado"]);
            const introPackRows = open.filter((r) => r.canal === "Intro Pack");
            const otherRows = open.filter((r) => r.canal !== "Intro Pack");
            for (const row of otherRows) {
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
            if (introPackRows.length > 0) {
                try {
                    const { firstPackByEmail, subsByEmail, membershipsByEmail } = await loadConversionCheckData();
                    for (const row of introPackRows) {
                        if (!row.email)
                            continue;
                        const email = row.email.toLowerCase().trim();
                        const pack = firstPackByEmail.get(email);
                        // No matching intro-pack record found (e.g. excluded/staff
                        // email, or data since changed) — leave it alone rather than
                        // guess.
                        if (!pack)
                            continue;
                        if (hasConvertedAfter(email, pack.expiresAt, subsByEmail, membershipsByEmail)) {
                            await notion.archivePage(row.id);
                            archivedConverted++;
                        }
                    }
                }
                catch (err) {
                    log.error("leads_reconcile.check_intro_pack_converted_failed", { message: errMsg(err) });
                }
            }
        }
        catch (err) {
            log.error("leads_reconcile.fetch_open_failed", { message: errMsg(err) });
        }
    }
    log.info("leads_reconcile.done", { archivedClosed, archivedConverted });
}
