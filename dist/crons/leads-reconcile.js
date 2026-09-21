/**
 * Weekly cleanup of "Leads a contactar" — the founder's call: this DB
 * should only ever show people who genuinely still need a follow-up. She
 * wants the list "viva" (alive) — whatever she sets Estado to by hand,
 * the next cron pass tidies away.
 *
 * 1. Any row marked Estado="Perdido", "Convertido", or "Inconclusivo" gets
 *    archived unconditionally — all three are closed states the founder
 *    sets by hand in Notion, this is just the "next time the cron runs,
 *    tidy it away" half of that workflow. ("Inconclusivo" added 2026-09-21:
 *    for when the message thread alone doesn't say whether the person
 *    converted or was lost — same terminal weight as the other two, not an
 *    open one. Convertido/Inconclusivo are never the bot's own write — see
 *    point 2 — only ever a manual override, but once set the row shouldn't
 *    stick around either.)
 *
 *    EXCEPTION: Perdido/Inconclusivo rows on the Intro Pack channel are
 *    left alone, NOT archived. Archiving makes a page invisible to every
 *    future Notion query (Notion excludes archived pages from query
 *    results, with no way to opt back in) — and leads-intro-pack.ts
 *    re-derives the same candidate every Monday for as long as that
 *    person's pack stays unconverted (there's no independent "already
 *    rejected" signal for it the way there is for Convertido, which the
 *    Studio Supabase purchase data itself guarantees won't recur).
 *    Archiving a Perdido Intro Pack row made it invisible to
 *    leads-intro-pack.ts's dedup check, so the following Monday it
 *    silently recreated the same person as a fresh "Novo" lead — undoing
 *    the founder's Perdido call (broke in production 2026-09-21, e.g.
 *    Marta Somborn). Inconclusivo carries the exact same risk for the same
 *    reason, so it gets the same treatment pre-emptively. Leaving the row
 *    un-archived keeps it visible to that dedup check forever, at the cost
 *    of it staying visible in Notion instead of disappearing — the
 *    founder's explicit trade-off.
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
    let keptClosedIntroPack = 0;
    try {
        const closed = await notion.getLeadsByEstado(["Perdido", "Convertido", "Inconclusivo"]);
        for (const row of closed) {
            // See the module docstring's EXCEPTION: archiving a Perdido or
            // Inconclusivo Intro Pack row would make it invisible to
            // leads-intro-pack.ts's dedup check, which would then recreate it
            // the following Monday.
            if ((row.estado === "Perdido" || row.estado === "Inconclusivo") && row.canal === "Intro Pack") {
                keptClosedIntroPack++;
                log.debug("leads_reconcile.kept_closed_intro_pack", { pageId: row.id, estado: row.estado });
                continue;
            }
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
    log.info("leads_reconcile.done", { archivedClosed, archivedConverted, keptClosedIntroPack });
}
