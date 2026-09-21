/**
 * Weekly scan of the studio's Instagram DM inbox (public.inbox_contacts /
 * public.inbox_messages in Studio Supabase — Mafalda's own tooling, see
 * src/lib/instagram-inbox.ts). Classifies each contact's whole
 * conversation into one of four buckets and routes accordingly:
 *   - "cliente": genuine information request from a prospective client —
 *     written into "Leads a contactar" (Canal = "Instagram"), same as the
 *     email/intro-pack pipelines.
 *   - "parceiro": another Pilates/wellness business or professional
 *     proposing a genuine business collaboration (workshop, event,
 *     corporate, cross-promotion) — written into "Partner Pipeline"
 *     (Categoria = "Parceria") instead. Founder's call, 2026-09-21: these
 *     shouldn't dilute the client-leads list, but they're a real signal
 *     worth tracking, in the same DB/workflow as every other partner
 *     contact (she moves it to "On hold"/"Arquivado" by hand).
 *   - "influencer": a content creator offering to try a class in exchange
 *     for posting about it — written into "Influencer Pipeline" instead
 *     (Canal de contacto = "Instagram DM"). Founder's call, 2026-09-21:
 *     distinct from "parceiro" because that DB already has the right
 *     fields (follower count, collaboration type) for this specific case.
 *   - "nenhum": none of the above — dropped, debug-level only. Explicitly
 *     includes job applications and vendor/supplier sales pitches, which
 *     the classifier is instructed NOT to call "parceiro" (founder's
 *     call, 2026-09-21, after the dry-run review turned up e.g. a cleaning-
 *     supplies vendor and several "are you hiring?" messages wrongly
 *     landing as partner candidates).
 * A fifth case is handled BEFORE classification, with no Haiku call at
 * all: a contact the studio itself cold-messaged (e.g. an influencer/
 * brand outreach campaign) who never replied. Whether we contacted them
 * first is a data fact (src/lib/instagram-inbox.ts's hasInboundMessage),
 * not a judgment call — and it matters, because an out-only transcript
 * still contains OUR OWN "queríamos explorar uma parceria" language and
 * fooled the classifier into a false "parceiro" the first time this
 * shipped (2026-09-21). These are still worth tracking rather than
 * dropped (founder's call, same day): written into Partner Pipeline like
 * "parceiro", but Status="Contactado" instead of the default
 * "A contactar", since we're the ones waiting to hear back.
 *
 * Classification is per CONTACT, not per message — one Haiku call on
 * their whole transcript, since this is a holistic judgment, not
 * something any single message answers alone.
 *
 * One checkpoint file (data/instagram-leads-sync-state.json under
 * DATA_DIR) covers BOTH the historical backlog and new DMs going forward:
 * its first run has an empty checkpoint, so every contact gets classified
 * (the backfill); every run after that only re-examines a contact whose
 * message_count grew since it last looked.
 *
 * Dedup is checkpoint-only, not Notion-side: most Instagram contacts have
 * no email, so findLeadByEmail/findLeadByEmailAny (both email-keyed) can't
 * help here the way they do for the email/intro-pack channels — this file
 * is the only record of "did we already create a page for this person"
 * (lead OR partner). State is saved after every contact (not batched at
 * the end) so a crash mid-run can't leave a created-but-unrecorded page to
 * be duplicated next run. Once a contact has a notionPageId, we NEVER
 * create a second page for them — even if they message again, even if the
 * founder changes that row's status — same posture as the
 * leads-reconcile.ts/leads-intro-pack.ts fix (2026-09-21): status is
 * founder-managed, a closed/moved row is a deliberate act a cron doesn't
 * re-litigate. She can reopen by hand.
 */
import fs from "node:fs";
import path from "node:path";
import { buildTranscript, extractVolunteeredEmail, extractVolunteeredPhone, fetchInstagramContactsWithMessages, hasInboundMessage, isExcludedInstagramContact, } from "../lib/instagram-inbox.js";
import { checkExistingCustomer, fetchAllCustomerNames, fetchAllVisitHistory, findBestNameMatch, findVisitHistory, } from "../lib/leads.js";
import { classifyInstagramDM, enrichInfluencerFromTranscript, enrichPartnerFromTranscript, summarizeRelationshipUpdate, } from "../lib/lead-classifier.js";
import { log } from "../lib/log.js";
import { isStudioDbAvailable } from "../lib/studio-db.js";
import { sendGroupMessage } from "../lib/telegram.js";
import { formatInfluencerCandidatesDigests, formatLeadsDigests, formatPartnerCandidatesDigests, } from "../messages/leads.js";
import * as notion from "../notion.js";
const DATA_DIR = process.env.DATA_DIR ?? ".";
const STATE_PATH = path.join(DATA_DIR, "instagram-leads-sync-state.json");
function loadState() {
    try {
        return JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
    }
    catch {
        return {};
    }
}
function saveState(state) {
    try {
        fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
        fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
    }
    catch (err) {
        log.error("leads_instagram_scan.save_state_failed", { message: errMsg(err) });
    }
}
function errMsg(err) {
    return err instanceof Error ? err.message : String(err);
}
function formatDatePt(iso) {
    const [y, m, d] = iso.slice(0, 10).split("-");
    return `${d}/${m}/${y}`;
}
/**
 * Only trusts a VOLUNTEERED email for asserting real Kenko visit history —
 * a fuzzy name match is flagged as uncertain instead of fed into the visit
 * lookup, since stating "already visited N times" off a guessed identity
 * would overclaim. Mirrors this file's existing "Match incerto — rever
 * manualmente" posture for the lead-matching path below.
 */
function formatKenkoLine(volunteeredEmail, name, customers, activity) {
    if (volunteeredEmail) {
        const history = findVisitHistory(volunteeredEmail, activity);
        if (history && history.visitCount > 0 && history.firstVisit && history.lastVisit) {
            return `Kenko: já visitou o estúdio — ${history.visitCount} visitas, primeira em ${formatDatePt(history.firstVisit)}, última em ${formatDatePt(history.lastVisit)}.`;
        }
        return "Kenko: sem histórico de visitas para este email.";
    }
    const fuzzy = findBestNameMatch(name, customers);
    if (fuzzy) {
        return `Kenko: possível correspondência (nome semelhante a ${fuzzy.name}) — por confirmar manualmente.`;
    }
    return "Kenko: sem correspondência.";
}
function dated(text) {
    return `[${formatDatePt(new Date().toISOString())}] ${text}`;
}
/**
 * "Current state" fields only (Sobre/Deal/Perfil e stats) — always judged
 * from the FULL transcript, since e.g. a deal's terms can only be read
 * correctly in light of the whole conversation, and always REPLACES the
 * section so re-running as a conversation evolves never piles up stale
 * versions. Returns the raw enrichment (including .log) so callers decide
 * separately how to handle the Log/Relação e histórico entry — first-time
 * creation logs the whole-transcript summary as the opening entry;
 * reEnrichContact logs a delta-only summary instead (see below), so this
 * never appends anything itself.
 */
async function applyPartnerCurrentState(pageId, transcript) {
    const enrichment = await enrichPartnerFromTranscript(transcript);
    if (!enrichment)
        return null;
    if (enrichment.sobre)
        await notion.replacePageSection(pageId, enrichment.sobre, "Sobre o parceiro");
    if (enrichment.deal)
        await notion.replacePageSection(pageId, enrichment.deal, "Deal e proposta");
    return enrichment;
}
async function applyInfluencerCurrentState(pageId, transcript, name, volunteeredEmail, customers, activity, ultimoContacto) {
    const enrichment = await enrichInfluencerFromTranscript(transcript);
    const kenkoLine = formatKenkoLine(volunteeredEmail, name, customers, activity);
    const perfilStats = [enrichment?.sobre, kenkoLine].filter((s) => Boolean(s)).join("\n");
    if (perfilStats)
        await notion.replacePageSection(pageId, perfilStats, "Perfil e stats");
    await notion.updateInfluencerFields(pageId, {
        status: enrichment?.status,
        tipoColaboracao: enrichment?.tipoColaboracao,
        nicho: enrichment?.nicho,
        proximoPasso: enrichment?.proximoPasso,
        ultimoContacto,
    });
    return enrichment ?? null;
}
/**
 * First-time enrichment, called right after a partner/influencer page is
 * created. Best-effort: every step logs and swallows its own failure
 * rather than throwing, so a Haiku/Notion hiccup here never affects the
 * page that's already been created, or the checkpoint that already
 * recorded it — enrichment is a bonus on top of a real page, not a
 * condition for one. Logs the whole-transcript summary as the Log
 * section's opening entry (there's no prior entry to build a delta from
 * yet).
 */
async function enrichPartnerPage(pageId, transcript) {
    try {
        const enrichment = await applyPartnerCurrentState(pageId, transcript);
        if (enrichment?.log)
            await notion.appendToPageSection(pageId, dated(enrichment.log), "Log");
    }
    catch (err) {
        log.warn("leads_instagram_scan.enrich_failed", { pageId, kind: "partner", message: errMsg(err) });
    }
}
async function enrichInfluencerPage(pageId, transcript, name, volunteeredEmail, customers, activity, ultimoContacto) {
    try {
        const enrichment = await applyInfluencerCurrentState(pageId, transcript, name, volunteeredEmail, customers, activity, ultimoContacto);
        if (enrichment?.log)
            await notion.appendToPageSection(pageId, dated(enrichment.log), "Relação e histórico");
    }
    catch (err) {
        log.warn("leads_instagram_scan.enrich_failed", { pageId, kind: "influencer", message: errMsg(err) });
    }
}
/**
 * Re-enrichment for a contact that already has a page and got new
 * messages since the last checkpoint. Never creates or touches a second
 * page — only refreshes Sobre/Deal/Perfil e stats (current-state, full
 * transcript) and appends ONE new dated Log/Relação e histórico entry
 * summarizing just the new messages (delta transcript), so the log stays
 * a readable chronological journal instead of repeating the whole history
 * every run. Returns true on success (caller advances messageCountSeen);
 * false leaves the checkpoint stale so the next run's delta naturally
 * includes whatever was missed, same retry posture as the rest of this
 * file.
 */
async function reEnrichContact(contact, existing, customers, activity) {
    if (existing.classification !== "parceiro" && existing.classification !== "influencer")
        return true;
    const pageId = existing.notionPageId;
    if (!pageId)
        return true;
    const name = contact.displayName || contact.username || `Instagram ${contact.platformUserId}`;
    const fullTranscript = buildTranscript(contact.messages);
    const deltaTranscript = buildTranscript(contact.messages.slice(existing.messageCountSeen));
    if (!fullTranscript)
        return true;
    try {
        if (existing.classification === "parceiro") {
            await applyPartnerCurrentState(pageId, fullTranscript);
        }
        else {
            const volunteeredEmail = extractVolunteeredEmail(contact.messages);
            await applyInfluencerCurrentState(pageId, fullTranscript, name, volunteeredEmail, customers, activity, contact.lastMessageAt);
        }
        if (deltaTranscript) {
            const update = await summarizeRelationshipUpdate(deltaTranscript);
            if (update) {
                const section = existing.classification === "parceiro" ? "Log" : "Relação e histórico";
                await notion.appendToPageSection(pageId, dated(update), section);
            }
        }
        return true;
    }
    catch (err) {
        log.warn("leads_instagram_scan.reenrich_failed", { contactId: contact.id, message: errMsg(err) });
        return false;
    }
}
function setCheckpoint(state, contact, classification, notionPageId) {
    state[contact.id] = {
        messageCountSeen: contact.messageCount,
        classification,
        notionPageId,
        classifiedAt: new Date().toISOString(),
    };
}
async function processContact(contact, customers, activity, state) {
    const name = contact.displayName || contact.username || `Instagram ${contact.platformUserId}`;
    // contact.platformUserId is Meta's internal numeric id — never surface it
    // as if it were a usable handle (it isn't searchable/linkable). Most
    // historical (manual_upload) contacts have no username at all — Instagram's
    // "download your data" export doesn't include the other person's @handle,
    // only their display name — found 2026-09-21 after shipping this without
    // it: the founder couldn't re-contact anyone from the Origem field alone.
    const handle = contact.username ? `@${contact.username}` : "sem @ (só nome no Instagram)";
    const origem = `Instagram DM · ${handle} · ${contact.messageCount} mensagens · contacto ${contact.id}`;
    // A contact the studio cold-messaged (e.g. an influencer/brand outreach
    // campaign) who never replied still has a non-empty transcript — our
    // own message — so this must be checked before building/classifying it,
    // not instead of it. No AI judgment needed here: whether we contacted
    // them first is a data fact, not something to classify. Still worth
    // tracking (founder's call, 2026-09-21) rather than silently dropping —
    // written the same as an inbound "parceiro", just Status="Contactado"
    // instead of the default "A contactar", since we're the ones waiting to
    // hear back, not them waiting on us.
    if (!hasInboundMessage(contact.messages)) {
        if (!buildTranscript(contact.messages)) {
            setCheckpoint(state, contact, "nenhum", null);
            return null;
        }
        try {
            const pageId = await notion.createPartner(name, "Unassigned", origem, "Parceria", "Contactado", contact.lastMessageAt);
            setCheckpoint(state, contact, "parceiro", pageId);
            return { type: "partner", summary: { nome: name } };
        }
        catch (err) {
            log.error("leads_instagram_scan.partner_write_failed", { contactId: contact.id, message: errMsg(err) });
            return null; // leave checkpoint untouched — retry next run
        }
    }
    const transcript = buildTranscript(contact.messages);
    if (!transcript) {
        setCheckpoint(state, contact, "nenhum", null);
        return null;
    }
    let classification;
    try {
        classification = await classifyInstagramDM(transcript);
    }
    catch (err) {
        log.error("leads_instagram_scan.classify_failed", { contactId: contact.id, message: errMsg(err) });
        return null; // leave checkpoint untouched — retry next run
    }
    if (classification === "nenhum") {
        setCheckpoint(state, contact, classification, null);
        return null;
    }
    if (classification === "parceiro") {
        let pageId;
        try {
            pageId = await notion.createPartner(name, "Unassigned", origem, "Parceria", "A contactar", contact.lastMessageAt);
            setCheckpoint(state, contact, classification, pageId);
        }
        catch (err) {
            log.error("leads_instagram_scan.partner_write_failed", { contactId: contact.id, message: errMsg(err) });
            return null; // leave checkpoint untouched — retry next run
        }
        // Outside the try/catch above: the page is created and checkpointed at
        // this point no matter what happens next — enrichPartnerPage already
        // swallows its own failures, so it can never turn a successful create
        // into a misleading "write_failed" log.
        await enrichPartnerPage(pageId, transcript);
        return { type: "partner", summary: { nome: name } };
    }
    if (classification === "influencer") {
        let pageId;
        try {
            pageId = await notion.createInfluencer(name, "Unassigned", origem, "Instagram DM", contact.lastMessageAt);
            setCheckpoint(state, contact, classification, pageId);
        }
        catch (err) {
            log.error("leads_instagram_scan.influencer_write_failed", { contactId: contact.id, message: errMsg(err) });
            return null; // leave checkpoint untouched — retry next run
        }
        const volunteeredEmail = extractVolunteeredEmail(contact.messages);
        await enrichInfluencerPage(pageId, transcript, name, volunteeredEmail, customers, activity, contact.lastMessageAt);
        return { type: "influencer", summary: { nome: name } };
    }
    // classification === "cliente"
    const email = extractVolunteeredEmail(contact.messages);
    const phone = extractVolunteeredPhone(contact.messages);
    try {
        const check = await checkExistingCustomer(email, name, customers);
        if (check.isExistingCustomer) {
            log.info("leads_instagram_scan.skipped_existing_customer", { contactId: contact.id });
            setCheckpoint(state, contact, classification, null);
            return null;
        }
        const verificacao = check.fuzzyMatch
            ? "Match incerto — rever manualmente"
            : "Sem correspondência";
        const motivo = `Pedido de informação via Instagram DM (${contact.messageCount} mensagens trocadas)`;
        const pageId = await notion.createLead(name, email, "Instagram", motivo, verificacao, origem, {
            telefone: phone,
        });
        setCheckpoint(state, contact, classification, pageId);
        return { type: "lead", summary: { nome: name, canal: "Instagram" } };
    }
    catch (err) {
        log.error("leads_instagram_scan.write_failed", { contactId: contact.id, message: errMsg(err) });
        return null; // leave checkpoint untouched — retry next run
    }
}
export async function run() {
    if (!process.env.NOTION_LEADS_DB_ID) {
        log.debug("leads_instagram_scan.skipped", { reason: "NOTION_LEADS_DB_ID not set" });
        return;
    }
    if (!isStudioDbAvailable()) {
        log.debug("leads_instagram_scan.skipped", { reason: "studio_db_not_configured" });
        return;
    }
    let contacts;
    let customers;
    let activity;
    try {
        [contacts, customers, activity] = await Promise.all([
            fetchInstagramContactsWithMessages(),
            fetchAllCustomerNames(),
            fetchAllVisitHistory(),
        ]);
    }
    catch (err) {
        log.error("leads_instagram_scan.fetch_failed", { message: errMsg(err) });
        return;
    }
    const state = loadState();
    const createdLeads = [];
    const createdPartners = [];
    const createdInfluencers = [];
    let skippedExcluded = 0;
    let skippedNoNewActivity = 0;
    for (const contact of contacts) {
        if (isExcludedInstagramContact(contact)) {
            skippedExcluded++;
            continue;
        }
        const existing = state[contact.id];
        if (existing?.notionPageId) {
            // Already has a page (lead or partner) — never create a second one.
            // New messages since last time re-run enrichment (parceiro/influencer
            // only) rather than just silently bumping the message count — see
            // reEnrichContact. A failed re-enrichment leaves messageCountSeen
            // stale on purpose, so the next run's delta naturally includes what
            // was missed.
            if (existing.messageCountSeen !== contact.messageCount) {
                const shouldReEnrich = contact.messageCount > existing.messageCountSeen;
                const ok = shouldReEnrich ? await reEnrichContact(contact, existing, customers, activity) : true;
                if (ok) {
                    state[contact.id] = { ...existing, messageCountSeen: contact.messageCount };
                    saveState(state);
                }
            }
            continue;
        }
        if (existing && existing.messageCountSeen >= contact.messageCount) {
            skippedNoNewActivity++;
            continue;
        }
        const result = await processContact(contact, customers, activity, state);
        saveState(state);
        if (result?.type === "lead")
            createdLeads.push(result.summary);
        if (result?.type === "partner")
            createdPartners.push(result.summary);
        if (result?.type === "influencer")
            createdInfluencers.push(result.summary);
    }
    log.info("leads_instagram_scan.done", {
        totalContacts: contacts.length,
        skippedExcluded,
        skippedNoNewActivity,
        createdLeads: createdLeads.length,
        createdPartners: createdPartners.length,
        createdInfluencers: createdInfluencers.length,
    });
    for (const message of formatLeadsDigests(createdLeads)) {
        try {
            const messageId = await sendGroupMessage(message);
            log.info("leads_instagram_scan.leads_posted", { messageId });
        }
        catch (err) {
            log.error("leads_instagram_scan.leads_send_failed", { message: errMsg(err) });
        }
    }
    for (const message of formatPartnerCandidatesDigests(createdPartners)) {
        try {
            const messageId = await sendGroupMessage(message);
            log.info("leads_instagram_scan.partners_posted", { messageId });
        }
        catch (err) {
            log.error("leads_instagram_scan.partners_send_failed", { message: errMsg(err) });
        }
    }
    for (const message of formatInfluencerCandidatesDigests(createdInfluencers)) {
        try {
            const messageId = await sendGroupMessage(message);
            log.info("leads_instagram_scan.influencers_posted", { messageId });
        }
        catch (err) {
            log.error("leads_instagram_scan.influencers_send_failed", { message: errMsg(err) });
        }
    }
}
