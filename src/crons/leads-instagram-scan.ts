/**
 * Weekly scan of the studio's Instagram DM inbox (public.inbox_contacts /
 * public.inbox_messages in Studio Supabase — Mafalda's own tooling, see
 * src/lib/instagram-inbox.ts) for people who asked a genuine information
 * question, writing them into the same "Leads a contactar" Notion DB as
 * the email/intro-pack pipelines (Canal = "Instagram").
 *
 * Classification is per CONTACT, not per message — one Haiku call on
 * their whole transcript, since "did this person ever ask us for
 * information" is a holistic judgment, not something any single message
 * answers alone.
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
 * is the only record of "did we already create a lead for this person."
 * State is saved after every contact (not batched at the end) so a crash
 * mid-run can't leave a created-but-unrecorded lead to be duplicated next
 * run. Once a contact has a notionPageId, we NEVER create a second lead
 * for them — even if they message again, even if the founder marks that
 * row "Perdido" — same posture as the leads-reconcile.ts/leads-intro-pack.ts
 * fix (2026-09-21): Estado is founder-managed, a closed lead is a
 * deliberate act a cron doesn't re-litigate. She can reopen by hand.
 */

import fs from "node:fs";
import path from "node:path";

import {
  buildTranscript,
  extractVolunteeredEmail,
  extractVolunteeredPhone,
  fetchInstagramContactsWithMessages,
  isExcludedInstagramContact,
  type InstagramContactWithMessages,
} from "../lib/instagram-inbox.js";
import { checkExistingCustomer, fetchAllCustomerNames, type CustomerNameRecord } from "../lib/leads.js";
import { isGenuineInformationRequestDM } from "../lib/lead-classifier.js";
import { log } from "../lib/log.js";
import { isStudioSupabaseAvailable } from "../lib/studio-supabase.js";
import { sendGroupMessage } from "../lib/telegram.js";
import { formatLeadsDigests, type NewLeadSummary } from "../messages/leads.js";
import * as notion from "../notion.js";
import type { LeadVerification } from "../types.js";

const DATA_DIR = process.env.DATA_DIR ?? ".";
const STATE_PATH = path.join(DATA_DIR, "instagram-leads-sync-state.json");

interface ContactState {
  messageCountSeen: number;
  isLead: boolean;
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

async function processContact(
  contact: InstagramContactWithMessages,
  customers: CustomerNameRecord[],
  state: SyncState,
): Promise<NewLeadSummary | null> {
  const transcript = buildTranscript(contact.messages);
  if (!transcript) {
    state[contact.id] = {
      messageCountSeen: contact.messageCount,
      isLead: false,
      notionPageId: null,
      classifiedAt: new Date().toISOString(),
    };
    return null;
  }

  let isLead: boolean;
  try {
    isLead = await isGenuineInformationRequestDM(transcript);
  } catch (err) {
    log.error("leads_instagram_scan.classify_failed", { contactId: contact.id, message: errMsg(err) });
    return null; // leave checkpoint untouched — retry next run
  }

  if (!isLead) {
    state[contact.id] = {
      messageCountSeen: contact.messageCount,
      isLead: false,
      notionPageId: null,
      classifiedAt: new Date().toISOString(),
    };
    return null;
  }

  const name = contact.displayName || contact.username || `Instagram ${contact.platformUserId}`;
  const email = extractVolunteeredEmail(contact.messages);
  const phone = extractVolunteeredPhone(contact.messages);

  try {
    const check = await checkExistingCustomer(email, name, customers);
    if (check.isExistingCustomer) {
      log.info("leads_instagram_scan.skipped_existing_customer", { contactId: contact.id });
      state[contact.id] = {
        messageCountSeen: contact.messageCount,
        isLead: true,
        notionPageId: null,
        classifiedAt: new Date().toISOString(),
      };
      return null;
    }

    const verificacao: LeadVerification = check.fuzzyMatch
      ? "Match incerto — rever manualmente"
      : "Sem correspondência";
    const handle = contact.username ? `@${contact.username}` : contact.platformUserId;
    const origem = `Instagram DM · ${handle} · ${contact.messageCount} mensagens · contacto ${contact.id}`;
    const motivo = `Pedido de informação via Instagram DM (${contact.messageCount} mensagens trocadas)`;

    const pageId = await notion.createLead(name, email, "Instagram", motivo, verificacao, origem, {
      telefone: phone,
    });

    state[contact.id] = {
      messageCountSeen: contact.messageCount,
      isLead: true,
      notionPageId: pageId,
      classifiedAt: new Date().toISOString(),
    };
    return { nome: name, canal: "Instagram" };
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
  const created: NewLeadSummary[] = [];
  let skippedExcluded = 0;
  let skippedNoNewActivity = 0;

  for (const contact of contacts) {
    if (isExcludedInstagramContact(contact)) {
      skippedExcluded++;
      continue;
    }

    const existing = state[contact.id];
    if (existing?.notionPageId) {
      // Already has a lead — never create a second one. Just keep the
      // checkpoint's message count current.
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

    const lead = await processContact(contact, customers, state);
    saveState(state);
    if (lead) created.push(lead);
  }

  log.info("leads_instagram_scan.done", {
    totalContacts: contacts.length,
    skippedExcluded,
    skippedNoNewActivity,
    created: created.length,
  });

  const messages = formatLeadsDigests(created);
  if (messages.length === 0) return;
  for (const message of messages) {
    try {
      const messageId = await sendGroupMessage(message);
      log.info("leads_instagram_scan.posted", { messageId });
    } catch (err) {
      log.error("leads_instagram_scan.send_failed", { message: errMsg(err) });
    }
  }
}
