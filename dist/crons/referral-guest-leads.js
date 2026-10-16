/**
 * Daily: keeps the "Referidos e convidados" Notion list (NOTION_REFERRAL_GUESTS_DB_ID) in step with
 * va.v_pulse_referral_guest_leads — people referred with an ambassador's code or brought to a class
 * as a guest, who never paid — so the founders push them to buy an intro pack (Madalena, 2026-10-16,
 * design agreed in a grilling session). Every rule is the view's (Haven-Comms
 * docs/PROMPT-referral-guest-leads-haven-studio.md); src/lib/referral-guest-leads.ts maps it.
 *
 * - New today → "A contactar" + one group message listing them (at most one a day, silent otherwise).
 * - Bought an intro pack → "Comprou intro pack" (they then show up in Tracking intro packs);
 *   membership → "Convertido"; anything else → "Comprou outra coisa". A purchase wins over any Estado.
 * - 30 days without buying (the view's `cold`) → "Cold lead", only over A contactar / Contactado,
 *   and a lead in "Leads a contactar" with Canal "Referral" / "Convidado" (no duplicate when an open
 *   lead exists for the email; no message, like every lead since 2026-10-05). Perdido never becomes
 *   a lead, Follow up never goes cold.
 * - Rows are never deleted; "Notas" and "Último contacto" are never written.
 *
 * Does nothing until the view exists. Writes nothing when the view comes back empty while the list
 * has rows. REFERRAL_GUESTS_DRY_RUN=true logs the plan and the message, writes and posts nothing.
 *
 * Schedule: 08:18 Europe/Lisbon every day. Registered in src/server.ts.
 * See docs/knowledge-base/referral-guest-leads.md.
 */
import { log } from "../lib/log.js";
import { sendGroupMessageWithSource } from "../lib/pulse-source.js";
import { fetchMemberIdentity, fetchReferralGuestLeads, PULSE_VIEW } from "../lib/pulse-views.js";
import { planReferralGuests } from "../lib/referral-guest-leads.js";
import { isStudioDbAvailable } from "../lib/studio-db.js";
import { formatReferralGuestDigest } from "../messages/referral-guest-leads.js";
import * as notion from "../notion.js";
function errMsg(err) {
    return err instanceof Error ? err.message : String(err);
}
async function createLeadFor(name, fields) {
    if (!process.env.NOTION_LEADS_DB_ID || !fields.email)
        return;
    if (await notion.findLeadByEmail(fields.email)) {
        log.info("cron.referral_guest_leads.lead_exists", { origem: fields.origem });
        return;
    }
    await notion.createLead(name, fields.email, fields.origem, `${fields.origem}${fields.trazidaPor ? ` via ${fields.trazidaPor}` : ""} desde ${fields.entrouEm}; sem compras 30 dias depois.`, "N/A", "Referidos e convidados (cold)", { ...(fields.telefone ? { telefone: fields.telefone } : {}), nVisitas: fields.aulasFeitas });
}
export async function run() {
    if (!process.env.NOTION_REFERRAL_GUESTS_DB_ID) {
        log.debug("cron.referral_guest_leads.skipped", { reason: "NOTION_REFERRAL_GUESTS_DB_ID not set" });
        return;
    }
    if (!isStudioDbAvailable()) {
        log.debug("cron.referral_guest_leads.skipped", { reason: "studio_db_not_configured" });
        return;
    }
    const dryRun = process.env.REFERRAL_GUESTS_DRY_RUN === "true";
    let plan;
    let asOf = null;
    try {
        const view = await fetchReferralGuestLeads();
        if (view === null) {
            log.info("cron.referral_guest_leads.skipped", { reason: "view_missing", view: PULSE_VIEW.referralGuestLeads });
            return;
        }
        const [rows, identity] = await Promise.all([notion.getAllReferralGuestRows(), fetchMemberIdentity()]);
        if (view.length === 0 && rows.length > 0) {
            log.warn("cron.referral_guest_leads.empty_view", { notionRows: rows.length });
            return;
        }
        asOf = view[0]?.data_as_of ?? null;
        const people = new Map(identity.map((i) => [i.member_id, { name: i.contact_name, email: i.contact_email, phone: i.contact_phone }]));
        plan = planReferralGuests(view, rows, people);
    }
    catch (err) {
        log.error("cron.referral_guest_leads.fetch_failed", { message: errMsg(err) });
        return;
    }
    const counts = {
        asOf,
        creates: plan.creates.length,
        updates: plan.updates.length,
        estadoChanges: plan.updates.filter((u) => u.estado).length,
        toLead: plan.toLead.size,
        dryRun,
    };
    if (dryRun) {
        log.info("cron.referral_guest_leads.dry_run", {
            ...counts,
            creates: plan.creates.map((c) => ({ name: c.name, estado: c.estado, fields: c.fields })),
            estadoChanges: plan.updates.filter((u) => u.estado).map((u) => ({ name: u.name, estado: u.estado })),
            message: formatReferralGuestDigest(plan.creates),
        });
        return;
    }
    const created = [];
    for (const c of plan.creates) {
        try {
            await notion.createReferralGuestRow(c.name, c.memberId, c.fields, c.estado);
            created.push(c);
            if (plan.toLead.has(c.memberId))
                await createLeadFor(c.name, c.fields);
        }
        catch (err) {
            log.error("cron.referral_guest_leads.create_failed", { memberId: c.memberId, message: errMsg(err) });
        }
    }
    for (const u of plan.updates) {
        try {
            await notion.updateReferralGuestRow(u.pageId, u.fields, u.estado);
            if (u.estado === "Cold lead")
                await createLeadFor(u.name, u.fields);
        }
        catch (err) {
            log.error("cron.referral_guest_leads.update_failed", { pageId: u.pageId, message: errMsg(err) });
        }
    }
    log.info("cron.referral_guest_leads.synced", counts);
    // Announced only once in Notion: a failed create retries tomorrow and is announced then.
    const message = formatReferralGuestDigest(created);
    if (!message)
        return;
    try {
        const messageId = await sendGroupMessageWithSource(message, [PULSE_VIEW.referralGuestLeads], asOf);
        log.info("cron.referral_guest_leads.posted", { messageId });
    }
    catch (err) {
        log.error("cron.referral_guest_leads.send_failed", { message: errMsg(err) });
    }
}
