/**
 * Weekly scan of the studio's Instagram DM inbox (public.inbox_contacts /
 * public.inbox_messages in Studio Supabase — Mafalda's own tooling, see
 * src/lib/instagram-inbox.ts). Classifies each contact's whole
 * conversation into one of three buckets and routes accordingly:
 *   - "cliente": genuine information request from a prospective client —
 *     written into "Leads a contactar" (Canal = "Instagram"), same as the
 *     email/intro-pack pipelines.
 *   - "parceiro": another Pilates/wellness business or professional
 *     reaching out for networking, not asking to become a client —
 *     written into "Partner Pipeline" (Categoria = "Parceria") instead.
 *     Founder's call, 2026-09-21: these shouldn't dilute the client-leads
 *     list, but they're a real signal worth tracking, in the same DB/
 *     workflow as every other partner contact (she moves it to "On hold"
 *     or "Arquivado" by hand depending on how the conversation goes).
 *   - "nenhum": neither — dropped, debug-level only.
 * A fourth case is handled BEFORE classification, with no Haiku call at
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

import {
  buildTranscript,
  extractVolunteeredEmail,
  extractVolunteeredPhone,
  fetchInstagramContactsWithMessages,
  hasInboundMessage,
  isExcludedInstagramContact,
  type InstagramContactWithMessages,
} from "../lib/instagram-inbox.js";
import { checkExistingCustomer, fetchAllCustomerNames, type CustomerNameRecord } from "../lib/leads.js";
import { classifyInstagramDM, type InstagramDMClassification } from "../lib/lead-classifier.js";
import { log } from "../lib/log.js";
import { isStudioSupabaseAvailable } from "../lib/studio-supabase.js";
import { sendGroupMessage } from "../lib/telegram.js";
import {
  formatLeadsDigests,
  formatPartnerCandidatesDigests,
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
  | null;

async function processContact(
  contact: InstagramContactWithMessages,
  customers: CustomerNameRecord[],
  state: SyncState,
): Promise<ProcessResult> {
  const name = contact.displayName || contact.username || `Instagram ${contact.platformUserId}`;
  const handle = contact.username ? `@${contact.username}` : contact.platformUserId;
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
      const pageId = await notion.createPartner(name, "Unassigned", origem, "Parceria", "Contactado");
      setCheckpoint(state, contact, "parceiro", pageId);
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
    try {
      const pageId = await notion.createPartner(name, "Unassigned", origem, "Parceria");
      setCheckpoint(state, contact, classification, pageId);
      return { type: "partner", summary: { nome: name } };
    } catch (err) {
      log.error("leads_instagram_scan.partner_write_failed", { contactId: contact.id, message: errMsg(err) });
      return null; // leave checkpoint untouched — retry next run
    }
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
  if (!isStudioSupabaseAvailable()) {
    log.debug("leads_instagram_scan.skipped", { reason: "studio_supabase_not_configured" });
    return;
  }

  let contacts: InstagramContactWithMessages[];
  let customers: CustomerNameRecord[];
  try {
    [contacts, customers] = await Promise.all([fetchInstagramContactsWithMessages(), fetchAllCustomerNames()]);
  } catch (err) {
    log.error("leads_instagram_scan.fetch_failed", { message: errMsg(err) });
    return;
  }

  const state = loadState();
  const createdLeads: NewLeadSummary[] = [];
  const createdPartners: NewPartnerSummary[] = [];
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
      // Just keep the checkpoint's message count current.
      if (existing.messageCountSeen !== contact.messageCount) {
        state[contact.id] = { ...existing, messageCountSeen: contact.messageCount };
        saveState(state);
      }
      continue;
    }
    if (existing && existing.messageCountSeen >= contact.messageCount) {
      skippedNoNewActivity++;
      continue;
    }

    const result = await processContact(contact, customers, state);
    saveState(state);
    if (result?.type === "lead") createdLeads.push(result.summary);
    if (result?.type === "partner") createdPartners.push(result.summary);
  }

  log.info("leads_instagram_scan.done", {
    totalContacts: contacts.length,
    skippedExcluded,
    skippedNoNewActivity,
    createdLeads: createdLeads.length,
    createdPartners: createdPartners.length,
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
}
