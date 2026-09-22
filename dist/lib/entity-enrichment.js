/**
 * Shared "fill in a Partner/Influencer Pipeline page from whatever text we
 * have" logic — extracted from src/crons/leads-instagram-scan.ts (2026-09-21)
 * so every creation path (Instagram DM, the Outlook partnerships sync,
 * manual chat creation via the assistant's create_entity tool, and any
 * future channel — WhatsApp, once unblocked) can reuse the exact same
 * behavior instead of forking it. Channel-agnostic: takes plain text, not
 * an Instagram-specific "transcript" — the enrichment prompts
 * (partner-enrichment.md/influencer-enrichment.md) already only care about
 * content, not delivery mechanism.
 *
 * Two layers, matching what "current state" vs. "log" actually mean:
 * - applyPartnerCurrentState/applyInfluencerCurrentState write the
 *   "current state" fields (Sobre/Deal/Perfil e stats + Influencer
 *   Pipeline's Status/Nicho/Tipo de colaboração/Próximo passo) via
 *   replacePageSection/updateInfluencerFields — always REPLACES, so
 *   re-running as a conversation evolves never piles up stale versions.
 *   Exported separately (not just via the wrapper below) because
 *   leads-instagram-scan.ts's reEnrichContact needs to call these alone —
 *   it handles the Log/Relação e histórico entry itself, as a delta
 *   summary of just the new messages, not the whole-transcript summary
 *   these return in enrichment.log.
 * - enrichPartnerPageFromText/enrichInfluencerPageFromText are the
 *   first-time, best-effort wrapper: current-state fields, then the
 *   whole-text summary as the Log/Relação e histórico section's opening
 *   entry. Every step logs and swallows its own failure — a Haiku/Notion
 *   hiccup here must never affect a page that's already been created, or a
 *   checkpoint that already recorded it. Enrichment is a bonus on top of a
 *   real page, never a condition for one.
 */
import { enrichInfluencerFromTranscript, enrichPartnerFromTranscript, enrichSupplierFromTranscript, } from "./lead-classifier.js";
import { findBestNameMatch, findVisitHistory } from "./leads.js";
import { log } from "./log.js";
import * as notion from "../notion.js";
function errMsg(err) {
    return err instanceof Error ? err.message : String(err);
}
export function formatDatePt(iso) {
    const [y, m, d] = iso.slice(0, 10).split("-");
    return `${d}/${m}/${y}`;
}
export function dated(text) {
    return `[${formatDatePt(new Date().toISOString())}] ${text}`;
}
/**
 * Only trusts a VOLUNTEERED email for asserting real Kenko visit history —
 * a fuzzy name match is flagged as uncertain instead of fed into the visit
 * lookup, since stating "already visited N times" off a guessed identity
 * would overclaim.
 */
export function formatKenkoLine(volunteeredEmail, name, customers, activity) {
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
export async function applyPartnerCurrentState(pageId, text) {
    const enrichment = await enrichPartnerFromTranscript(text);
    if (!enrichment)
        return null;
    if (enrichment.sobre)
        await notion.replacePageSection(pageId, enrichment.sobre, "Sobre o parceiro");
    if (enrichment.deal)
        await notion.replacePageSection(pageId, enrichment.deal, "Deal e proposta");
    return enrichment;
}
/** Same shape as applyPartnerCurrentState, for Fornecedores — no Kenko
 * cross-reference (a supplier selling to us has no client visit history to
 * check). */
export async function applySupplierCurrentState(pageId, text) {
    const enrichment = await enrichSupplierFromTranscript(text);
    if (!enrichment)
        return null;
    if (enrichment.sobre)
        await notion.replacePageSection(pageId, enrichment.sobre, "Sobre o fornecedor");
    if (enrichment.termos)
        await notion.replacePageSection(pageId, enrichment.termos, "Termos e condições");
    return enrichment;
}
export async function applyInfluencerCurrentState(pageId, text, name, ctx = {}) {
    const enrichment = await enrichInfluencerFromTranscript(text);
    // Kenko cross-reference only makes sense when a caller supplied both the
    // customer roster and visit-activity map (a Studio DB round-trip) — a
    // caller that doesn't want that extra cost (e.g. a quick manual-chat
    // enrichment) can omit them and just skip the line entirely.
    const kenkoLine = ctx.customers && ctx.activity
        ? formatKenkoLine(ctx.volunteeredEmail ?? null, name, ctx.customers, ctx.activity)
        : null;
    const perfilStats = [enrichment?.sobre, kenkoLine].filter((s) => Boolean(s)).join("\n");
    if (perfilStats)
        await notion.replacePageSection(pageId, perfilStats, "Perfil e stats");
    await notion.updateInfluencerFields(pageId, {
        status: enrichment?.status,
        tipoColaboracao: enrichment?.tipoColaboracao,
        nicho: enrichment?.nicho,
        proximoPasso: enrichment?.proximoPasso,
        ultimoContacto: ctx.ultimoContacto,
        // Captures a volunteered email the moment we see one — even for an
        // Instagram-sourced influencer, so the email-side sync (once built)
        // can recognize her by exact_email if she later writes in from her
        // inbox. A caller with no email to report (ctx.volunteeredEmail
        // undefined/null) leaves the property untouched, same "only write
        // what we actually know" rule every other field here follows.
        email: ctx.volunteeredEmail,
    });
    return enrichment ?? null;
}
export async function enrichPartnerPageFromText(pageId, text) {
    try {
        const enrichment = await applyPartnerCurrentState(pageId, text);
        if (enrichment?.log)
            await notion.appendToPageSection(pageId, dated(enrichment.log), "Log");
    }
    catch (err) {
        log.warn("entity_enrichment.failed", { pageId, kind: "partner", message: errMsg(err) });
    }
}
export async function enrichSupplierPageFromText(pageId, text) {
    try {
        const enrichment = await applySupplierCurrentState(pageId, text);
        if (enrichment?.log)
            await notion.appendToPageSection(pageId, dated(enrichment.log), "Log");
    }
    catch (err) {
        log.warn("entity_enrichment.failed", { pageId, kind: "supplier", message: errMsg(err) });
    }
}
export async function enrichInfluencerPageFromText(pageId, text, name, ctx = {}) {
    try {
        const enrichment = await applyInfluencerCurrentState(pageId, text, name, ctx);
        if (enrichment?.log)
            await notion.appendToPageSection(pageId, dated(enrichment.log), "Relação e histórico");
    }
    catch (err) {
        log.warn("entity_enrichment.failed", { pageId, kind: "influencer", message: errMsg(err) });
    }
}
