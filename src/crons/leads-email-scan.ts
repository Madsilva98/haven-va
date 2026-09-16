/**
 * Weekly scan of configured Outlook mailboxes (OUTLOOK_MAILBOXES, same
 * config as the partnerships sync) for genuine information-request emails
 * that never got followed up. A single unattended cron, deliberately not
 * split into scan/apply scripts like sync-partnerships — there is no
 * human-judgment triage step here, only a mechanical purchase check, so
 * the read/write split wouldn't buy any extra safety, only weekly toil.
 *
 * Pipeline: scan since last checkpoint -> drop the Haven's own mail ->
 * classify with Claude Haiku -> skip anyone who already purchased
 * (src/lib/leads.ts) -> skip anyone already an open lead -> write to
 * "Leads a contactar" -> one digest to the Telegram group, silent if
 * nothing new.
 *
 * Own checkpoint file (data/leads-email-sync-state.json under DATA_DIR),
 * separate from sync-partnerships' data/outlook-sync-state.json — the two
 * pipelines run on different cadences and shouldn't share a "since" clock.
 */

import fs from "node:fs";
import path from "node:path";

import { checkExistingCustomer, fetchAllCustomerNames, type CustomerNameRecord } from "../lib/leads.js";
import { isGenuineInformationRequest } from "../lib/lead-classifier.js";
import { log } from "../lib/log.js";
import * as outlook from "../lib/outlook.js";
import { sendGroupMessage } from "../lib/telegram.js";
import { formatLeadsDigest, type NewLeadSummary } from "../messages/leads.js";
import * as notion from "../notion.js";
import type { LeadVerification } from "../types.js";

const DATA_DIR = process.env.DATA_DIR ?? ".";
const STATE_PATH = path.join(DATA_DIR, "leads-email-sync-state.json");
const OVERLAP_MS = 24 * 60 * 60 * 1000; // 1-day overlap buffer, same as sync-partnerships

interface SyncState {
  [mailbox: string]: { lastSyncedISO: string };
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
    log.error("leads_email_scan.save_state_failed", {
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

function configuredMailboxes(): string[] {
  const extra = (process.env.OUTLOOK_MAILBOXES ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return ["me", ...extra];
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function run(): Promise<void> {
  if (!process.env.NOTION_LEADS_DB_ID) {
    log.debug("leads_email_scan.skipped", { reason: "NOTION_LEADS_DB_ID not set" });
    return;
  }
  if (!outlook.isAuthenticated()) {
    log.debug("leads_email_scan.skipped", { reason: "outlook_not_authenticated" });
    return;
  }

  let ownEmail: string;
  try {
    ownEmail = (await outlook.getMyEmail()).toLowerCase();
  } catch (err) {
    log.error("leads_email_scan.get_my_email_failed", { message: errMsg(err) });
    return;
  }

  const mailboxes = configuredMailboxes();
  const ownDomains = new Set<string>();
  const ownDomain = ownEmail.split("@")[1];
  if (ownDomain) ownDomains.add(ownDomain);
  for (const mb of mailboxes) {
    const domain = mb.includes("@") ? mb.split("@")[1]?.toLowerCase() : undefined;
    if (domain) ownDomains.add(domain);
  }

  let customers: CustomerNameRecord[];
  try {
    customers = await fetchAllCustomerNames();
  } catch (err) {
    log.error("leads_email_scan.fetch_customers_failed", { message: errMsg(err) });
    return;
  }

  const state = loadState();
  const scanStartedAt = new Date();
  const created: NewLeadSummary[] = [];

  for (const mailbox of mailboxes) {
    const lastSyncedISO = state[mailbox]?.lastSyncedISO;
    const sinceISO = lastSyncedISO
      ? new Date(new Date(lastSyncedISO).getTime() - OVERLAP_MS).toISOString()
      : undefined;

    let messages: outlook.OutlookMessage[];
    try {
      messages = await outlook.searchMailboxMessages(mailbox, sinceISO ? { sinceISO } : {});
    } catch (err) {
      log.error("leads_email_scan.mailbox_scan_failed", { mailbox, message: errMsg(err) });
      continue;
    }

    for (const msg of messages) {
      const fromDomain = msg.from.email.split("@")[1]?.toLowerCase();
      if (fromDomain && ownDomains.has(fromDomain)) continue; // the Haven's own mail

      let isLead: boolean;
      try {
        isLead = await isGenuineInformationRequest(`${msg.subject}\n\n${msg.body}`);
      } catch {
        continue;
      }
      if (!isLead) continue;

      const email = msg.from.email || null;
      const name = msg.from.name || email || "Desconhecido";

      try {
        const check = await checkExistingCustomer(email, name, customers);
        if (check.isExistingCustomer) continue;

        if (email) {
          const existingLead = await notion.findLeadByEmail(email);
          if (existingLead) continue; // already an open lead for this person
        }

        const verificacao: LeadVerification = check.fuzzyMatch
          ? "Match incerto — rever manualmente"
          : "Sem correspondência";
        const origem = `${mailbox} · ${msg.from.name} <${msg.from.email}> · "${msg.subject}" · ${msg.receivedDateTime}`;
        const mensagem = (msg.bodyPreview || msg.body).slice(0, 1000);

        await notion.createLead(name, email, "Email", mensagem, verificacao, origem);
        created.push({ nome: name, canal: "Email" });
      } catch (err) {
        log.error("leads_email_scan.write_failed", { email, message: errMsg(err) });
      }
    }

    state[mailbox] = { lastSyncedISO: scanStartedAt.toISOString() };
  }

  saveState(state);

  const message = formatLeadsDigest(created);
  if (!message) {
    log.info("leads_email_scan.no_new_leads", {});
    return;
  }
  try {
    const messageId = await sendGroupMessage(message);
    log.info("leads_email_scan.posted", { messageId, count: created.length });
  } catch (err) {
    log.error("leads_email_scan.send_failed", { message: errMsg(err) });
  }
}
