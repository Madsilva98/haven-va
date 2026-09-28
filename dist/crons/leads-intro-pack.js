/**
 * Weekly scan for intro packs that finished at least 21 days ago (the
 * empirically validated day — see src/lib/intro-pack-conversion.ts) with
 * no conversion since. Writes into the same "Leads a contactar" Notion DB
 * as the email pipeline (Canal = "Intro Pack"), since the founder's goal
 * here — ask for feedback, try to reconvert — is the same "someone to
 * follow up with" list, not a separate tracker.
 *
 * Every unconverted candidate still gets a Notion lead row created,
 * however overdue — nobody drops off the follow-up list. But the Telegram
 * digest only announces whoever crossed the 21-day mark recently
 * (DIGEST_WINDOW_DAYS): founder's call, 2026-09-28, after this cron's
 * first run under the pulse-views data path surfaced an 8-month-old
 * backlog (24-242 days unconverted) all at once, since none of them had a
 * Notion lead row yet. That backlog only existed because this was
 * effectively this cron's first real pass at that data — going forward,
 * each person is only ever a genuinely new Notion row once, so this
 * window mainly guards against a repeat: a future multi-week data gap
 * (asOf jumping forward all at once, same root cause as
 * src/lib/intro-pack-conversion.ts's isWithinExpiryWindow fix) shouldn't
 * flood the digest with long-overdue names again.
 */
import { log } from "../lib/log.js";
import { DEFAULT_CUTOFF_DAYS, describePostExpiryVisit, findUnconvertedIntroPacks, } from "../lib/intro-pack-conversion.js";
import { isStudioDbAvailable } from "../lib/studio-db.js";
import { sendGroupMessageWithSource } from "../lib/pulse-source.js";
import { PULSE_VIEW } from "../lib/pulse-views.js";
import { formatLeadsDigest } from "../messages/leads.js";
import * as notion from "../notion.js";
// One cron cycle's worth of slack past the day-21 threshold — a candidate
// this fresh past the cutoff is worth announcing; one from months ago is
// backlog, not news (see the file header for why the backlog can exist at
// all despite the create-once-per-email dedup below).
const DIGEST_WINDOW_DAYS = 7;
function errMsg(err) {
    return err instanceof Error ? err.message : String(err);
}
export async function run() {
    if (!process.env.NOTION_LEADS_DB_ID) {
        log.debug("leads_intro_pack.skipped", { reason: "NOTION_LEADS_DB_ID not set" });
        return;
    }
    if (!isStudioDbAvailable()) {
        log.debug("leads_intro_pack.skipped", { reason: "studio_db_not_configured" });
        return;
    }
    let candidates;
    let asOf;
    try {
        ({ candidates, asOf } = await findUnconvertedIntroPacks());
    }
    catch (err) {
        log.error("leads_intro_pack.fetch_failed", { message: errMsg(err) });
        return;
    }
    const created = [];
    const digestWorthy = [];
    let skippedExisting = 0;
    let backlogSuppressed = 0;
    for (const c of candidates) {
        try {
            // findLeadByEmailAny, not findLeadByEmail: an Intro Pack candidate
            // re-derives every Monday for as long as the pack stays unconverted,
            // so a row the founder marked Perdido (deliberately left un-archived
            // by leads-reconcile.ts for exactly this reason) must still block
            // recreation — findLeadByEmail's open-only filter would ignore it and
            // silently undo her Perdido call (broke in production 2026-09-21).
            // Scoped to canal: "Intro Pack" so a closed lead on a different
            // channel (Email/WhatsApp/Instagram) that hasn't been archived yet
            // can't false-positive block a legitimate new Intro Pack lead.
            const existing = await notion.findLeadByEmailAny(c.email, "Intro Pack");
            if (existing) {
                skippedExisting++;
                log.debug("leads_intro_pack.skipped_existing", { email: c.email, estado: existing.estado });
                continue; // already a lead (open, Perdido, or Convertido) for this person
            }
            const postExpiryNote = describePostExpiryVisit(c);
            const motivo = `${c.packName} — terminou há ${c.daysSinceExpiry} dias, sem converter para mensalidade${postExpiryNote ? ` — ${postExpiryNote}` : ""}`;
            const origem = `Intro pack "${c.packName}" terminado a ${c.expiresAt.toLocaleDateString("pt-PT", { timeZone: "Europe/Lisbon" })}`;
            await notion.createLead(c.name, c.email, "Intro Pack", motivo, "N/A", origem, {
                telefone: c.phone,
                pack: c.packName,
                ultimaVisita: c.lastVisit ? c.lastVisit.toISOString() : null,
                nVisitas: c.visitCount,
            });
            created.push({ nome: c.name, canal: "Intro Pack" });
            if (c.daysSinceExpiry < DEFAULT_CUTOFF_DAYS + DIGEST_WINDOW_DAYS) {
                digestWorthy.push({ nome: c.name, canal: "Intro Pack" });
            }
            else {
                backlogSuppressed++;
            }
        }
        catch (err) {
            log.error("leads_intro_pack.write_failed", { email: c.email, message: errMsg(err) });
        }
    }
    const message = formatLeadsDigest(digestWorthy);
    if (!message) {
        log.info("leads_intro_pack.no_new", {
            totalCandidates: candidates.length,
            skippedExisting,
            created: created.length,
            backlogSuppressed,
        });
        return;
    }
    try {
        const messageId = await sendGroupMessageWithSource(message, [PULSE_VIEW.introPurchase, PULSE_VIEW.introConversion, PULSE_VIEW.memberActivity], asOf);
        log.info("leads_intro_pack.posted", {
            messageId,
            count: digestWorthy.length,
            created: created.length,
            backlogSuppressed,
            skippedExisting,
        });
    }
    catch (err) {
        log.error("leads_intro_pack.send_failed", { message: errMsg(err) });
    }
}
