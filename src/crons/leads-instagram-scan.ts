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
 * A fifth case is handled BEFORE the CLIENTE/PARCEIRO/INFLUENCER/NENHUM
 * classification, with a different Haiku call: a contact the studio
 * itself cold-messaged (e.g. an influencer/brand outreach campaign) who
 * never replied. Whether we contacted them first is a data fact
 * (src/lib/instagram-inbox.ts's hasInboundMessage), not a judgment call —
 * an out-only transcript still contains OUR OWN language and fooled the
 * main classifier into a false "parceiro" the first time this shipped
 * (2026-09-21). But WHICH kind of outreach it was still needs judging —
 * classifyOutreachIntent (src/lib/lead-classifier.ts) reads our own
 * message to tell a partner-style ask (e.g. Wanderlust's goodie-bag
 * request) from the team's influencer-outreach template (e.g. Márcia
 * Soares's "achamos que fazes match com a nossa vibe"), since routing
 * every cold-outreach contact into Partner Pipeline unconditionally
 * (the original behavior) silently misrouted the latter too — found in
 * production 2026-09-21. Still worth tracking either way (founder's
 * call): written with Status="Contactado" instead of the default
 * "A contactar"/"A contactar", since we're the ones waiting to hear back.
 *
 * Before creating ANY Partner or Influencer Pipeline page (all three
 * paths above), the name is fuzzy-matched against every existing row in
 * that same pipeline (findDuplicateName) — this cron used to have zero
 * cross-channel dedup, so the same real contact reached both by email
 * (via the Outlook partnerships sync) and by Instagram DM got two rows
 * ("Wanderlust" and "Wanderlust_Portugal", found in production
 * 2026-09-21). A likely match skips creation and gets flagged in the
 * weekly digest instead — never auto-merged, since deciding which record
 * is authoritative needs a human.
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

import {
  buildTranscript,
  extractVolunteeredEmail,
  extractVolunteeredPhone,
  fetchInstagramContactsWithMessages,
  hasInboundMessage,
  isExcludedInstagramContact,
  type InstagramContactWithMessages,
} from "../lib/instagram-inbox.js";
import { scoreMatch } from "../lib/fuzzy-match.js";
import {
  checkExistingCustomer,
  fetchAllCustomerNames,
  fetchAllVisitHistory,
  findBestNameMatch,
  findVisitHistory,
  type CustomerNameRecord,
  type VisitHistory,
} from "../lib/leads.js";
import {
  classifyInstagramDM,
  classifyOutreachIntent,
  enrichInfluencerFromTranscript,
  enrichPartnerFromTranscript,
  summarizeRelationshipUpdate,
  type InstagramDMClassification,
} from "../lib/lead-classifier.js";
import { log } from "../lib/log.js";
import { isStudioDbAvailable } from "../lib/studio-db.js";
import { sendGroupMessage } from "../lib/telegram.js";
import {
  formatDuplicateCandidatesDigests,
  formatInfluencerCandidatesDigests,
  formatLeadsDigests,
  formatPartnerCandidatesDigests,
  type DuplicateCandidateSummary,
  type NewInfluencerSummary,
  type NewLeadSummary,
  type NewPartnerSummary,
} from "../messages/leads.js";
import * as notion from "../notion.js";
import type { LeadVerification } from "../types.js";

const DATA_DIR = process.env.DATA_DIR ?? ".";
const STATE_PATH = path.join(DATA_DIR, "instagram-leads-sync-state.json");

interface ContactState {
  messageCountSeen: number;
  classification: InstagramDMClassification;
  notionPageId: string | null;
  classifiedAt: string;
}

interface SyncState {
  [contactId: string]: ContactState;
}

function loadState(): SyncState {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, "utf8")) as SyncState;
  } catch {
    return {};
  }
}

function saveState(state: SyncState): void {
  try {
    fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
    fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
  } catch (err) {
    log.error("leads_instagram_scan.save_state_failed", { message: errMsg(err) });
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function formatDatePt(iso: string): string {
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
function formatKenkoLine(
  volunteeredEmail: string | null,
  name: string,
  customers: CustomerNameRecord[],
  activity: Map<string, VisitHistory>,
): string {
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

function dated(text: string): string {
  return `[${formatDatePt(new Date().toISOString())}] ${text}`;
}

interface NamedContact {
  id: string;
  name: string;
}

// Higher bar than leads.ts's findBestNameMatch (0.5) — that one only ever
// flags a lead as "rever manualmente", never suppresses the write, so a
// weak match is cheap to get wrong. This one skips page creation entirely,
// so a false positive would silently drop a real, different contact.
// scoreMatch's containment case (one name is a substring of the other,
// e.g. "Wanderlust" / "Wanderlust_Portugal" — the real duplicate found in
// production 2026-09-21) already scores 0.8, comfortably above this.
const DUPLICATE_NAME_THRESHOLD = 0.75;

// Below this, a cold-outreach message is almost certainly not real
// content to classify from. buildTranscript prepends "Haven: " (7 chars)
// to every line, so "You sent an attachment." (23 chars) becomes exactly
// 30 — a 30-char threshold let it through in production 2026-09-21
// (Martim Saudade e Silva wrongly moved to Influencer Pipeline off that
// alone). Every genuine outreach template seen in production is 300+
// chars with the prefix, so this has real margin, not a razor's edge.
const MIN_OUTREACH_TEXT_LENGTH = 60;

function findDuplicateName(name: string, existing: NamedContact[]): NamedContact | null {
  let best: (NamedContact & { score: number }) | null = null;
  for (const e of existing) {
    const score = scoreMatch(e.name, name);
    if (score >= DUPLICATE_NAME_THRESHOLD && (!best || score > best.score)) {
      best = { ...e, score };
    }
  }
  return best;
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
async function applyPartnerCurrentState(pageId: string, transcript: string) {
  const enrichment = await enrichPartnerFromTranscript(transcript);
  if (!enrichment) return null;
  if (enrichment.sobre) await notion.replacePageSection(pageId, enrichment.sobre, "Sobre o parceiro");
  if (enrichment.deal) await notion.replacePageSection(pageId, enrichment.deal, "Deal e proposta");
  return enrichment;
}

async function applyInfluencerCurrentState(
  pageId: string,
  transcript: string,
  name: string,
  volunteeredEmail: string | null,
  customers: CustomerNameRecord[],
  activity: Map<string, VisitHistory>,
  ultimoContacto: string | null,
) {
  const enrichment = await enrichInfluencerFromTranscript(transcript);
  const kenkoLine = formatKenkoLine(volunteeredEmail, name, customers, activity);
  const perfilStats = [enrichment?.sobre, kenkoLine].filter((s): s is string => Boolean(s)).join("\n");
  if (perfilStats) await notion.replacePageSection(pageId, perfilStats, "Perfil e stats");
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
async function enrichPartnerPage(pageId: string, transcript: string): Promise<void> {
  try {
    const enrichment = await applyPartnerCurrentState(pageId, transcript);
    if (enrichment?.log) await notion.appendToPageSection(pageId, dated(enrichment.log), "Log");
  } catch (err) {
    log.warn("leads_instagram_scan.enrich_failed", { pageId, kind: "partner", message: errMsg(err) });
  }
}

async function enrichInfluencerPage(
  pageId: string,
  transcript: string,
  name: string,
  volunteeredEmail: string | null,
  customers: CustomerNameRecord[],
  activity: Map<string, VisitHistory>,
  ultimoContacto: string | null,
): Promise<void> {
  try {
    const enrichment = await applyInfluencerCurrentState(
      pageId,
      transcript,
      name,
      volunteeredEmail,
      customers,
      activity,
      ultimoContacto,
    );
    if (enrichment?.log) await notion.appendToPageSection(pageId, dated(enrichment.log), "Relação e histórico");
  } catch (err) {
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
async function reEnrichContact(
  contact: InstagramContactWithMessages,
  existing: ContactState,
  customers: CustomerNameRecord[],
  activity: Map<string, VisitHistory>,
): Promise<boolean> {
  if (existing.classification !== "parceiro" && existing.classification !== "influencer") return true;
  const pageId = existing.notionPageId;
  if (!pageId) return true;

  const name = contact.displayName || contact.username || `Instagram ${contact.platformUserId}`;
  const fullTranscript = buildTranscript(contact.messages);
  const deltaTranscript = buildTranscript(contact.messages.slice(existing.messageCountSeen));
  if (!fullTranscript) return true;

  try {
    if (existing.classification === "parceiro") {
      await applyPartnerCurrentState(pageId, fullTranscript);
    } else {
      const volunteeredEmail = extractVolunteeredEmail(contact.messages);
      await applyInfluencerCurrentState(
        pageId,
        fullTranscript,
        name,
        volunteeredEmail,
        customers,
        activity,
        contact.lastMessageAt,
      );
    }
    if (deltaTranscript) {
      const update = await summarizeRelationshipUpdate(deltaTranscript);
      if (update) {
        const section = existing.classification === "parceiro" ? "Log" : "Relação e histórico";
        await notion.appendToPageSection(pageId, dated(update), section);
      }
    }
    return true;
  } catch (err) {
    log.warn("leads_instagram_scan.reenrich_failed", { contactId: contact.id, message: errMsg(err) });
    return false;
  }
}

function setCheckpoint(
  state: SyncState,
  contact: InstagramContactWithMessages,
  classification: InstagramDMClassification,
  notionPageId: string | null,
): void {
  state[contact.id] = {
    messageCountSeen: contact.messageCount,
    classification,
    notionPageId,
    classifiedAt: new Date().toISOString(),
  };
}

type ProcessResult =
  | { type: "lead"; summary: NewLeadSummary }
  | { type: "partner"; summary: NewPartnerSummary }
  | { type: "influencer"; summary: NewInfluencerSummary }
  | { type: "duplicate"; summary: DuplicateCandidateSummary }
  | null;

async function processContact(
  contact: InstagramContactWithMessages,
  customers: CustomerNameRecord[],
  activity: Map<string, VisitHistory>,
  existingPartners: NamedContact[],
  existingInfluencers: NamedContact[],
  state: SyncState,
): Promise<ProcessResult> {
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
  // not instead of it. Whether we contacted them first is a data fact,
  // not a judgment call — but WHICH kind of outreach it was (partner-
  // shaped vs. influencer-shaped) still needs one: until 2026-09-21 every
  // cold-outreach contact went into Partner Pipeline unconditionally,
  // which silently misrouted the team's own influencer-outreach template
  // ("achamos que fazes match com a nossa vibe, vem experimentar uma
  // aula") there too (e.g. Márcia Soares) — classifyOutreachIntent reads
  // OUR OWN message to tell the two apart, same distinction
  // classifyInstagramDM makes for an inbound reply, just applied to an
  // out-only thread instead.
  if (!hasInboundMessage(contact.messages)) {
    const outreachText = buildTranscript(contact.messages);
    if (!outreachText) {
      setCheckpoint(state, contact, "nenhum", null);
      return null;
    }
    // Meta's export sometimes has no real text for an attachment-only
    // message ("You sent an attachment.", 25 chars) or a bare reaction
    // ("Heheheh") — found in production 2026-09-21 feeding the classifier
    // effectively nothing to go on, producing an unreliable guess. Below
    // this bar, skip the Haiku call and use the same safe default as an
    // API failure, rather than classify noise.
    let intent: "parceiro" | "influencer";
    if (outreachText.length < MIN_OUTREACH_TEXT_LENGTH) {
      intent = "parceiro";
    } else {
      try {
        intent = await classifyOutreachIntent(outreachText);
      } catch (err) {
        log.error("leads_instagram_scan.outreach_classify_failed", { contactId: contact.id, message: errMsg(err) });
        return null; // leave checkpoint untouched — retry next run
      }
    }

    if (intent === "influencer") {
      const dup = findDuplicateName(name, existingInfluencers);
      if (dup) {
        setCheckpoint(state, contact, "influencer", null);
        log.info("leads_instagram_scan.duplicate_skipped", { contactId: contact.id, existing: dup.name });
        return { type: "duplicate", summary: { nome: name, existente: dup.name, pipeline: "Influencer Pipeline" } };
      }
      try {
        const pageId = await notion.createInfluencer(
          name,
          "Unassigned",
          origem,
          "Instagram DM",
          contact.lastMessageAt,
          "Contactado",
        );
        setCheckpoint(state, contact, "influencer", pageId);
        existingInfluencers.push({ id: pageId, name });
        return { type: "influencer", summary: { nome: name } };
      } catch (err) {
        log.error("leads_instagram_scan.influencer_write_failed", { contactId: contact.id, message: errMsg(err) });
        return null; // leave checkpoint untouched — retry next run
      }
    }

    // intent === "parceiro" — same "we contacted them, still waiting to
    // hear back" posture as before, Status="Contactado" not the default
    // "A contactar".
    const dup = findDuplicateName(name, existingPartners);
    if (dup) {
      setCheckpoint(state, contact, "parceiro", null);
      log.info("leads_instagram_scan.duplicate_skipped", { contactId: contact.id, existing: dup.name });
      return { type: "duplicate", summary: { nome: name, existente: dup.name, pipeline: "Partner Pipeline" } };
    }
    try {
      const pageId = await notion.createPartner(
        name,
        "Unassigned",
        origem,
        "Parceria",
        "Contactado",
        contact.lastMessageAt,
      );
      setCheckpoint(state, contact, "parceiro", pageId);
      existingPartners.push({ id: pageId, name });
      return { type: "partner", summary: { nome: name } };
    } catch (err) {
      log.error("leads_instagram_scan.partner_write_failed", { contactId: contact.id, message: errMsg(err) });
      return null; // leave checkpoint untouched — retry next run
    }
  }

  const transcript = buildTranscript(contact.messages);
  if (!transcript) {
    setCheckpoint(state, contact, "nenhum", null);
    return null;
  }

  let classification: InstagramDMClassification;
  try {
    classification = await classifyInstagramDM(transcript);
  } catch (err) {
    log.error("leads_instagram_scan.classify_failed", { contactId: contact.id, message: errMsg(err) });
    return null; // leave checkpoint untouched — retry next run
  }

  if (classification === "nenhum") {
    setCheckpoint(state, contact, classification, null);
    return null;
  }

  if (classification === "parceiro") {
    const dup = findDuplicateName(name, existingPartners);
    if (dup) {
      setCheckpoint(state, contact, classification, null);
      log.info("leads_instagram_scan.duplicate_skipped", { contactId: contact.id, existing: dup.name });
      return { type: "duplicate", summary: { nome: name, existente: dup.name, pipeline: "Partner Pipeline" } };
    }
    let pageId: string;
    try {
      pageId = await notion.createPartner(
        name,
        "Unassigned",
        origem,
        "Parceria",
        "A contactar",
        contact.lastMessageAt,
      );
      setCheckpoint(state, contact, classification, pageId);
      existingPartners.push({ id: pageId, name });
    } catch (err) {
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
    const dup = findDuplicateName(name, existingInfluencers);
    if (dup) {
      setCheckpoint(state, contact, classification, null);
      log.info("leads_instagram_scan.duplicate_skipped", { contactId: contact.id, existing: dup.name });
      return { type: "duplicate", summary: { nome: name, existente: dup.name, pipeline: "Influencer Pipeline" } };
    }
    let pageId: string;
    try {
      pageId = await notion.createInfluencer(
        name,
        "Unassigned",
        origem,
        "Instagram DM",
        contact.lastMessageAt,
      );
      setCheckpoint(state, contact, classification, pageId);
      existingInfluencers.push({ id: pageId, name });
    } catch (err) {
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

    const verificacao: LeadVerification = check.fuzzyMatch
      ? "Match incerto — rever manualmente"
      : "Sem correspondência";
    const motivo = `Pedido de informação via Instagram DM (${contact.messageCount} mensagens trocadas)`;

    const pageId = await notion.createLead(name, email, "Instagram", motivo, verificacao, origem, {
      telefone: phone,
    });

    setCheckpoint(state, contact, classification, pageId);
    return { type: "lead", summary: { nome: name, canal: "Instagram" } };
  } catch (err) {
    log.error("leads_instagram_scan.write_failed", { contactId: contact.id, message: errMsg(err) });
    return null; // leave checkpoint untouched — retry next run
  }
}

export async function run(): Promise<void> {
  if (!process.env.NOTION_LEADS_DB_ID) {
    log.debug("leads_instagram_scan.skipped", { reason: "NOTION_LEADS_DB_ID not set" });
    return;
  }
  if (!isStudioDbAvailable()) {
    log.debug("leads_instagram_scan.skipped", { reason: "studio_db_not_configured" });
    return;
  }

  let contacts: InstagramContactWithMessages[];
  let customers: CustomerNameRecord[];
  let activity: Map<string, VisitHistory>;
  let existingPartners: NamedContact[];
  let existingInfluencers: NamedContact[];
  try {
    [contacts, customers, activity, existingPartners, existingInfluencers] = await Promise.all([
      fetchInstagramContactsWithMessages(),
      fetchAllCustomerNames(),
      fetchAllVisitHistory(),
      notion.getAllPartnerContacts(),
      notion.getAllInfluencerContacts(),
    ]);
  } catch (err) {
    log.error("leads_instagram_scan.fetch_failed", { message: errMsg(err) });
    return;
  }

  const state = loadState();
  const createdLeads: NewLeadSummary[] = [];
  const createdPartners: NewPartnerSummary[] = [];
  const createdInfluencers: NewInfluencerSummary[] = [];
  const flaggedDuplicates: DuplicateCandidateSummary[] = [];
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

    const result = await processContact(
      contact,
      customers,
      activity,
      existingPartners,
      existingInfluencers,
      state,
    );
    saveState(state);
    if (result?.type === "lead") createdLeads.push(result.summary);
    if (result?.type === "partner") createdPartners.push(result.summary);
    if (result?.type === "influencer") createdInfluencers.push(result.summary);
    if (result?.type === "duplicate") flaggedDuplicates.push(result.summary);
  }

  log.info("leads_instagram_scan.done", {
    totalContacts: contacts.length,
    skippedExcluded,
    skippedNoNewActivity,
    createdLeads: createdLeads.length,
    createdPartners: createdPartners.length,
    createdInfluencers: createdInfluencers.length,
    flaggedDuplicates: flaggedDuplicates.length,
  });

  for (const message of formatLeadsDigests(createdLeads)) {
    try {
      const messageId = await sendGroupMessage(message);
      log.info("leads_instagram_scan.leads_posted", { messageId });
    } catch (err) {
      log.error("leads_instagram_scan.leads_send_failed", { message: errMsg(err) });
    }
  }

  for (const message of formatPartnerCandidatesDigests(createdPartners)) {
    try {
      const messageId = await sendGroupMessage(message);
      log.info("leads_instagram_scan.partners_posted", { messageId });
    } catch (err) {
      log.error("leads_instagram_scan.partners_send_failed", { message: errMsg(err) });
    }
  }

  for (const message of formatInfluencerCandidatesDigests(createdInfluencers)) {
    try {
      const messageId = await sendGroupMessage(message);
      log.info("leads_instagram_scan.influencers_posted", { messageId });
    } catch (err) {
      log.error("leads_instagram_scan.influencers_send_failed", { message: errMsg(err) });
    }
  }

  for (const message of formatDuplicateCandidatesDigests(flaggedDuplicates)) {
    try {
      const messageId = await sendGroupMessage(message);
      log.info("leads_instagram_scan.duplicates_posted", { messageId });
    } catch (err) {
      log.error("leads_instagram_scan.duplicates_send_failed", { message: errMsg(err) });
    }
  }
}
