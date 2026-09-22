/**
 * Weekly scan of the configured Outlook mailboxes (OUTLOOK_MAILBOXES, plus
 * "me") that creates/updates both Partner and Influencer Pipeline, the
 * email-side counterpart to src/crons/leads-instagram-scan.ts. Fully
 * automated, no human review gate — replaces the *live* path
 * scripts/scan-outlook-partnerships.mjs + apply-outlook-findings.mjs used
 * to cover; those manual scripts (and the sync-partnerships skill) stay in
 * the repo as an on-demand audit/backfill tool, same relationship
 * scripts/dry-run-instagram-leads.mjs has to the live Instagram cron.
 *
 * Per message, in order:
 *   1. Known-contact check, BOTH pipelines (src/lib/outlook-contact-matching.ts,
 *      built from notion.getAllPartnerContacts()/getAllInfluencerContacts()).
 *      An exact_email match is certain — auto-update that page directly, no
 *      classifier call needed. A domain match only proves "same
 *      organization", never "same initiative" (confirmed wrong for real
 *      once already, see outlook-contact-matching.ts) — never auto-updated,
 *      only carried into step 3 as a dedup candidate.
 *   2. Not a certain known-contact: classify with
 *      src/prompts/partnership-email-intent.md → parceiro / influencer /
 *      nenhum (src/lib/lead-classifier.ts's classifyPartnershipEmailIntent).
 *      This REPLACES keyword matching (the manual script's approach) —
 *      keyword matching alone has a confirmed real false-positive rate
 *      (SaaS/vendor noise), unsafe to run unattended. nenhum is dropped,
 *      checkpointed, never written anywhere.
 *   3. guessExternalParty (src/lib/outlook-contact-matching.ts) returns
 *      null when the Haven sent the message and no external recipient was
 *      found — an internal-only forward, most often a founder re-sharing a
 *      partnership email with the rest of the team. SKIPPED outright
 *      (logged, checkpointed) rather than naming a page after the sender:
 *      confirmed for real via the dry-run rehearsal
 *      (scripts/dry-run-sync-partnerships.mjs, 2026-09-22) that the
 *      pre-fix fallback silently created pages titled after a founder
 *      ("Madalena Marques Da Silva") instead of the actual partner. The
 *      genuine external thread this was forwarded FROM is either already a
 *      known contact (step 1) or gets classified correctly on its own when
 *      scanned directly.
 *   4. Dedup before create. Fuzzy-match the guessed name against
 *      notion.findPageInDb("partners" / "influencers", nome) — a
 *      domain-match hint from step 1 is checked here too, as a candidate.
 *      A match SKIPS creation (logged, never auto-merged — same "needs a
 *      human to decide which record is authoritative" posture as
 *      leads-instagram-scan.ts's dedup) rather than being touched.
 *   5. Create + enrich (src/lib/entity-enrichment.ts) + set Último contacto
 *      + forward/archive the source email (best-effort, mirrors
 *      apply-outlook-findings.mjs's forwardAndArchiveIfConfigured).
 *
 * No Telegram digest of any kind (founder's call, 2026-09-21 — same as
 * leads-instagram-scan.ts's partner/influencer creation): every outcome is
 * only a structured log line, readable in Notion directly.
 *
 * Checkpoint (data/partnerships-sync-state.json under DATA_DIR) has two
 * parts:
 *   - mailboxWatermarks: per-mailbox ISO timestamp, the earliest boundary
 *     the NEXT run's searchMailboxMessages sinceISO should start from.
 *     Advances to the latest message's receivedDateTime seen this run —
 *     UNLESS a message failed to process (API error), in which case it
 *     stops at that message's date instead, so next run's since-filter
 *     naturally re-includes it (and anything after it, which the
 *     per-message checkpoint below then no-ops on). First run per mailbox
 *     has no watermark — sinceISO is omitted, full history scanned, same
 *     "first run doubles as the historical backfill" pattern as
 *     leads-instagram-scan.ts.
 *   - messages: keyed by a stable hash of mailbox+messageId (findingId,
 *     mirrors scan-outlook-partnerships.mjs), so a message already decided
 *     is NEVER reprocessed even if a mailbox watermark rewind re-includes
 *     it in a later scan.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  enrichInfluencerPageFromText,
  enrichPartnerPageFromText,
} from "../lib/entity-enrichment.js";
import {
  classifyPartnershipEmailIntent,
  type PartnershipEmailClassification,
} from "../lib/lead-classifier.js";
import { log } from "../lib/log.js";
import * as outlook from "../lib/outlook.js";
import type { OutlookMessage } from "../lib/outlook.js";
import {
  buildContactLookups,
  domainOf,
  guessExternalParty,
  matchKnownContact,
  type ContactLookups,
  type KnownContact,
  type MatchBasis,
} from "../lib/outlook-contact-matching.js";
import * as notion from "../notion.js";

const DATA_DIR = process.env.DATA_DIR ?? ".";
const STATE_PATH = path.join(DATA_DIR, "partnerships-sync-state.json");

interface MessageState {
  classification: PartnershipEmailClassification;
  matchBasis: MatchBasis | null;
  pipeline: "partners" | "influencers" | null;
  notionPageId: string | null;
  processedAt: string;
}

interface SyncState {
  mailboxWatermarks: Record<string, string>;
  messages: Record<string, MessageState>;
}

function loadState(): SyncState {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_PATH, "utf8")) as Partial<SyncState>;
    return { mailboxWatermarks: raw.mailboxWatermarks ?? {}, messages: raw.messages ?? {} };
  } catch {
    return { mailboxWatermarks: {}, messages: {} };
  }
}

function saveState(state: SyncState): void {
  try {
    fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
    fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
  } catch (err) {
    log.error("sync_partnerships.save_state_failed", { message: errMsg(err) });
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function findingId(mailbox: string, messageId: string): string {
  return crypto.createHash("sha256").update(`${mailbox}:${messageId}`).digest("hex").slice(0, 12);
}

function setMessageCheckpoint(
  state: SyncState,
  msgKey: string,
  classification: PartnershipEmailClassification,
  matchBasis: MatchBasis | null,
  pipeline: "partners" | "influencers" | null,
  notionPageId: string | null,
): void {
  state.messages[msgKey] = {
    classification,
    matchBasis,
    pipeline,
    notionPageId,
    processedAt: new Date().toISOString(),
  };
}

function formatOrigem(msg: OutlookMessage): string {
  const to = msg.to.map((r) => `${r.name} <${r.email}>`).join(", ");
  return [
    `[Outlook sync automático] ${msg.mailbox}`,
    `De: ${msg.from.name} <${msg.from.email}>`,
    ...(to ? [`Para: ${to}`] : []),
    `Assunto: ${msg.subject}`,
    `Data: ${msg.receivedDateTime}`,
    "",
    msg.webLink,
  ].join("\n");
}

// Best-effort, mirrors apply-outlook-findings.mjs's forwardAndArchiveIfConfigured
// — but never throws, since a Graph mailbox hiccup here must never turn an
// already-successful Notion create/update into a "retry next run" (which
// would risk a second create attempt against a dedup check that may not
// yet see the just-written page). Leaving OUTLOOK_PARTNERSHIP_FORWARD_TO
// unset disables forwarding entirely (archive still happens).
async function forwardAndArchiveIfConfigured(msg: OutlookMessage): Promise<void> {
  const forwardTo = process.env.OUTLOOK_PARTNERSHIP_FORWARD_TO;
  if (!forwardTo) return;
  try {
    // A message already sitting in the forward target's own mailbox never
    // needs forwarding — Exchange delivers a self-forward as two
    // near-simultaneous copies (confirmed for real, see
    // apply-outlook-findings.mjs). Still archive it.
    const isSelfForward = msg.mailbox.toLowerCase() === forwardTo.toLowerCase();
    if (!isSelfForward) {
      await outlook.forwardMessage(
        msg.mailbox,
        msg.id,
        [forwardTo],
        "Reencaminhado automaticamente — registado no Partner/Influencer Pipeline.",
      );
    }
    await outlook.archiveMessage(msg.mailbox, msg.id);
  } catch (err) {
    log.warn("sync_partnerships.forward_archive_failed", {
      mailbox: msg.mailbox,
      messageId: msg.id,
      message: errMsg(err),
    });
  }
}

async function updateKnownPartner(contact: KnownContact, msg: OutlookMessage, text: string): Promise<void> {
  await notion.updatePartnerFields(contact.id, { ultimoContacto: msg.receivedDateTime });
  await enrichPartnerPageFromText(contact.id, text);
  await forwardAndArchiveIfConfigured(msg);
}

async function updateKnownInfluencer(contact: KnownContact, msg: OutlookMessage, text: string): Promise<void> {
  await enrichInfluencerPageFromText(contact.id, text, contact.name, { ultimoContacto: msg.receivedDateTime });
  await forwardAndArchiveIfConfigured(msg);
}

type ProcessOutcome =
  | {
      ok: true;
      result: "updated_known" | "created_partner" | "created_influencer" | "duplicate_skipped" | "nenhum" | "no_external_party";
    }
  | { ok: false };

async function processMessage(
  msg: OutlookMessage,
  ownDomains: Set<string>,
  partnerLookups: ContactLookups,
  influencerLookups: ContactLookups,
  state: SyncState,
): Promise<ProcessOutcome> {
  const msgKey = findingId(msg.mailbox, msg.id);
  const text = `${msg.subject}\n${msg.body}`;

  // Step 1: known-contact check, both pipelines. Only an exact_email match
  // is certain enough to auto-update without a classifier call.
  const partnerMatch = matchKnownContact(msg.from, msg.to, ownDomains, partnerLookups);
  const influencerMatch = matchKnownContact(msg.from, msg.to, ownDomains, influencerLookups);

  if (partnerMatch?.matchBasis === "exact_email") {
    try {
      await updateKnownPartner(partnerMatch.contact, msg, text);
      setMessageCheckpoint(state, msgKey, "parceiro", "exact_email", "partners", partnerMatch.contact.id);
      return { ok: true, result: "updated_known" };
    } catch (err) {
      log.error("sync_partnerships.known_partner_update_failed", {
        mailbox: msg.mailbox,
        messageId: msg.id,
        message: errMsg(err),
      });
      return { ok: false };
    }
  }
  if (influencerMatch?.matchBasis === "exact_email") {
    try {
      await updateKnownInfluencer(influencerMatch.contact, msg, text);
      setMessageCheckpoint(state, msgKey, "influencer", "exact_email", "influencers", influencerMatch.contact.id);
      return { ok: true, result: "updated_known" };
    } catch (err) {
      log.error("sync_partnerships.known_influencer_update_failed", {
        mailbox: msg.mailbox,
        messageId: msg.id,
        message: errMsg(err),
      });
      return { ok: false };
    }
  }

  // Step 2: classify (brand-new messages, and domain-hint-only messages —
  // a domain match alone is never certain enough to skip this).
  let classification: PartnershipEmailClassification;
  try {
    classification = await classifyPartnershipEmailIntent(text);
  } catch (err) {
    log.error("sync_partnerships.classify_failed", { mailbox: msg.mailbox, messageId: msg.id, message: errMsg(err) });
    return { ok: false };
  }

  if (classification === "nenhum") {
    setMessageCheckpoint(state, msgKey, classification, null, null, null);
    return { ok: true, result: "nenhum" };
  }

  const externalParty = guessExternalParty(msg.from, msg.to, ownDomains);
  if (!externalParty) {
    // The Haven sent this message and no external recipient was found —
    // an internal-only forward, most often a founder re-sharing a
    // partnership email with the rest of the team. There is no real
    // external party to name a page after here; guessing the sender's own
    // name (the pre-2026-09-22 behavior) silently created Partner/
    // Influencer Pipeline pages titled after a founder — confirmed for
    // real via the dry-run rehearsal (scripts/dry-run-sync-partnerships.mjs)
    // before this cron was ever trusted unattended. Skip outright: the
    // genuine external thread this was forwarded FROM is either already a
    // known contact (step 1) or will be classified correctly on its own
    // when scanned directly — see guessExternalParty's own docstring.
    setMessageCheckpoint(state, msgKey, classification, null, null, null);
    log.info("sync_partnerships.no_external_party_skipped", {
      mailbox: msg.mailbox,
      messageId: msg.id,
      classification,
    });
    return { ok: true, result: "no_external_party" };
  }
  const domainHintContact = classification === "parceiro" ? partnerMatch?.contact : influencerMatch?.contact;
  const dbKey = classification === "parceiro" ? "partners" : "influencers";

  // Step 3: dedup before create.
  const nameMatch = domainHintContact
    ? { id: domainHintContact.id, title: domainHintContact.name }
    : await notion.findPageInDb(dbKey, externalParty.name);

  if (nameMatch) {
    setMessageCheckpoint(state, msgKey, classification, domainHintContact ? "domain" : null, null, null);
    log.info("sync_partnerships.duplicate_skipped", {
      mailbox: msg.mailbox,
      messageId: msg.id,
      classification,
      existing: nameMatch.title,
    });
    return { ok: true, result: "duplicate_skipped" };
  }

  // Step 4: create + enrich + forward/archive.
  try {
    if (classification === "parceiro") {
      const pageId = await notion.createPartner(
        externalParty.name,
        "Unassigned",
        formatOrigem(msg),
        "Parceria",
        "A contactar",
        msg.receivedDateTime,
      );
      if (externalParty.email) await notion.updatePartnerFields(pageId, { email: externalParty.email });
      await enrichPartnerPageFromText(pageId, text);
      await forwardAndArchiveIfConfigured(msg);
      setMessageCheckpoint(state, msgKey, classification, null, "partners", pageId);
      return { ok: true, result: "created_partner" };
    }

    const pageId = await notion.createInfluencer(
      externalParty.name,
      "Unassigned",
      formatOrigem(msg),
      "Email",
      msg.receivedDateTime,
      "A contactar",
      externalParty.email || null,
    );
    await enrichInfluencerPageFromText(pageId, text, externalParty.name, {
      volunteeredEmail: externalParty.email || null,
    });
    await forwardAndArchiveIfConfigured(msg);
    setMessageCheckpoint(state, msgKey, classification, null, "influencers", pageId);
    return { ok: true, result: "created_influencer" };
  } catch (err) {
    log.error("sync_partnerships.write_failed", { mailbox: msg.mailbox, messageId: msg.id, message: errMsg(err) });
    return { ok: false };
  }
}

export async function run(): Promise<void> {
  if (!process.env.NOTION_PARTNER_DB_ID || !process.env.NOTION_INFLUENCER_DB_ID) {
    log.debug("sync_partnerships.skipped", { reason: "partner_or_influencer_db_not_set" });
    return;
  }
  if (!outlook.isAuthenticated()) {
    log.debug("sync_partnerships.skipped", { reason: "outlook_not_authenticated" });
    return;
  }

  const configuredMailboxes = (process.env.OUTLOOK_MAILBOXES ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const mailboxes = ["me", ...configuredMailboxes];

  let myEmail: string;
  let existingPartners: KnownContact[];
  let existingInfluencers: KnownContact[];
  try {
    [myEmail, existingPartners, existingInfluencers] = await Promise.all([
      outlook.getMyEmail(),
      notion.getAllPartnerContacts(),
      notion.getAllInfluencerContacts(),
    ]);
  } catch (err) {
    log.error("sync_partnerships.fetch_failed", { message: errMsg(err) });
    return;
  }

  const ownDomains = new Set(
    [domainOf(myEmail), ...configuredMailboxes.map(domainOf)].filter(Boolean),
  );
  const partnerLookups = buildContactLookups(existingPartners, ownDomains);
  const influencerLookups = buildContactLookups(existingInfluencers, ownDomains);

  const state = loadState();
  let updatedKnown = 0;
  let createdPartners = 0;
  let createdInfluencers = 0;
  let skippedDuplicates = 0;
  let skippedNenhum = 0;
  let skippedNoExternalParty = 0;

  for (const mailbox of mailboxes) {
    let messages: OutlookMessage[];
    try {
      messages = await outlook.searchMailboxMessages(mailbox, {
        sinceISO: state.mailboxWatermarks[mailbox],
      });
    } catch (err) {
      log.error("sync_partnerships.mailbox_fetch_failed", { mailbox, message: errMsg(err) });
      continue;
    }

    let minUnprocessed: string | null = null;
    let maxSeen: string | null = null;

    for (const msg of messages) {
      if (maxSeen === null || msg.receivedDateTime > maxSeen) maxSeen = msg.receivedDateTime;

      const msgKey = findingId(mailbox, msg.id);
      if (state.messages[msgKey]) continue; // already decided — a watermark rewind can re-include this

      const outcome = await processMessage(msg, ownDomains, partnerLookups, influencerLookups, state);
      if (outcome.ok) {
        saveState(state);
        if (outcome.result === "updated_known") updatedKnown++;
        else if (outcome.result === "created_partner") createdPartners++;
        else if (outcome.result === "created_influencer") createdInfluencers++;
        else if (outcome.result === "duplicate_skipped") skippedDuplicates++;
        else if (outcome.result === "nenhum") skippedNenhum++;
        else if (outcome.result === "no_external_party") skippedNoExternalParty++;
      } else if (minUnprocessed === null || msg.receivedDateTime < minUnprocessed) {
        minUnprocessed = msg.receivedDateTime;
      }
    }

    // Stops at the earliest unprocessed message so next run's since-filter
    // naturally retries it — otherwise advances to the latest message seen.
    const newWatermark = minUnprocessed ?? maxSeen;
    if (newWatermark) {
      state.mailboxWatermarks[mailbox] = newWatermark;
      saveState(state);
    }
  }

  // No Telegram digest — founder's call, 2026-09-21 (see file docstring).
  // Everything here is structured-log-only, readable in Notion directly.
  log.info("sync_partnerships.done", {
    mailboxes: mailboxes.length,
    updatedKnown,
    createdPartners,
    createdInfluencers,
    skippedDuplicates,
    skippedNenhum,
    skippedNoExternalParty,
  });
}
