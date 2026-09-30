/**
 * Daily email triage — ONE pass over the configured Outlook mailboxes that
 * cleans the shared inboxes, forwards to the right addresses, and records
 * partners / influencers / suppliers in Notion. Replaces the two crons that
 * used to do this separately and got in each other's way (founder's call,
 * 2026-09-30): tidy-mailboxes (daily, archived geral@/hello@) and
 * sync-partnerships (weekly, recorded in Notion but never read the Archive
 * — so anything tidy-mailboxes archived first, like the Fit4Life/Stages
 * negotiation, never reached Notion). A partner email in geral@ was also
 * classified by both, i.e. paid for twice.
 *
 * Per email, exactly once, in this order — so nothing is ever archived
 * before it's recorded:
 *   1. ONE AI verdict (src/lib/mail-verdict.ts): what it is (parceiro /
 *      influencer / fornecedor / candidatura / cliente / outro), whether
 *      it's a supplier invoice, whether something is still pending on our
 *      side. Skipped for known noise senders (src/lib/mail-rules.ts) and,
 *      outside the clean inboxes, for known contacts (exact email match).
 *      An unusable answer = undecided: nothing recorded/forwarded/archived,
 *      retried next run.
 *   2. RECORD in Notion (src/lib/mail-record.ts) — every mailbox, unread
 *      included (founder, 2026-09-30).
 *   3. FORWARD, each at most once (write-ahead in the state file, or the
 *      permanent Outlook category for invoices):
 *        - parceiro → OUTLOOK_PARTNERSHIP_FORWARD_TO (partners@)
 *        - fornecedor found in a personal mailbox (not a clean one) →
 *          OUTLOOK_SUPPLIERS_FORWARD_TO (geral@)
 *        - candidatura (job application) → OUTLOOK_STAFF_FORWARD_TO — only
 *          forwarded, never recorded anywhere (founder, 2026-09-30)
 *        - supplier invoice in a clean inbox → OUTLOOK_INVOICES_FORWARD_TO
 *      The first three only for mail received after this cron went live
 *      (state.forwardSince) and only when sent by someone outside the Haven
 *      — otherwise the first run would forward the whole backlog.
 *   4. CLEAN — only mailboxes in OUTLOOK_TIDY_MAILBOXES (geral@, hello@),
 *      only messages in the Inbox, only once read: archive if nothing is
 *      pending (open negotiations always count as pending), else tag
 *      "TidyBot: revisto". Fail-safes carried over unchanged: the founder's
 *      "não arquivar" tag (whole thread, wins over everything), "devia ter
 *      arquivado", the per-run archive cap, the 7-day recheck, and a newer
 *      Sent Items reply re-triggers the verdict.
 *
 * MAIL_TRIAGE_DRY_RUN=true runs everything (including the AI calls) but
 * writes nothing anywhere — no Notion, no forward, no archive, no category,
 * no state file — and logs mail_triage.would_* instead.
 *
 * State (DATA_DIR/mail-triage-state.json): per-mailbox watermark (as the old
 * sync), per-message memory keyed by a hash of mailbox+id (verdict, recorded,
 * forwards), and forwardSince. Seeded on first run from the old
 * partnerships-sync-state.json so nothing already recorded is redone.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { invoiceCandidateAttachments } from "../lib/invoice-detection.js";
import { log } from "../lib/log.js";
import {
  findExactKnownContact,
  recordNewContact,
  updateKnownContact,
  type Pipeline,
  type RecordContext,
  type RecordResult,
} from "../lib/mail-record.js";
import {
  AUTO_FORWARD_MARKER,
  FEEDBACK_SHOULD_ARCHIVE_CATEGORY,
  INVOICE_FORWARDED_CATEGORY,
  INVOICE_REJECTED_CATEGORY,
  TIDY_CATEGORY,
  ageInDays,
  isFromOwnDomain,
  isOwnAutoForward,
  matchNoiseRule,
  maxArchivesPerRun,
  recheckAfterDays,
} from "../lib/mail-rules.js";
import { classifyMail, type MailTipo } from "../lib/mail-verdict.js";
import * as outlook from "../lib/outlook.js";
import { isKeptInInbox, keptConversationIds } from "../lib/outlook.js";
import type { OutlookAttachment, OutlookMessage } from "../lib/outlook.js";
import { buildContactLookups, domainOf, type KnownContact } from "../lib/outlook-contact-matching.js";
import * as notion from "../notion.js";

const DATA_DIR = process.env.DATA_DIR ?? ".";
const STATE_PATH = path.join(DATA_DIR, "mail-triage-state.json");
const LEGACY_SYNC_STATE_PATH = path.join(DATA_DIR, "partnerships-sync-state.json");

interface MessageState {
  processedAt: string;
  recorded: boolean;
  pipeline?: Pipeline | null;
  notionPageId?: string | null;
  recordResult?: string;
  tipo?: MailTipo;
  needsAction?: boolean;
  isSupplierInvoice?: boolean;
  reason?: string;
  verdictAt?: string;
  /** sentDateTime of the Haven reply the verdict was based on, if any. */
  verdictReplyAt?: string;
  /** Attachments already looked at and the invoice pre-filter said no — don't refetch daily. */
  notInvoiceByKeywords?: boolean;
  forwardedTo?: string[];
}

interface TriageState {
  forwardSince: string;
  mailboxWatermarks: Record<string, string>;
  messages: Record<string, MessageState>;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isDryRun(): boolean {
  return process.env.MAIL_TRIAGE_DRY_RUN === "true";
}

function list(envValue: string | undefined): string[] {
  return (envValue ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

export function messageKey(mailbox: string, messageId: string): string {
  // Same hash the old sync used, so migrated entries line up.
  return crypto.createHash("sha256").update(`${mailbox}:${messageId}`).digest("hex").slice(0, 12);
}

function loadState(): TriageState {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_PATH, "utf8")) as Partial<TriageState>;
    return {
      forwardSince: raw.forwardSince ?? new Date().toISOString(),
      mailboxWatermarks: raw.mailboxWatermarks ?? {},
      messages: raw.messages ?? {},
    };
  } catch {
    // First run: seed from the retired sync-partnerships checkpoint.
    const fresh: TriageState = { forwardSince: new Date().toISOString(), mailboxWatermarks: {}, messages: {} };
    try {
      const legacy = JSON.parse(fs.readFileSync(LEGACY_SYNC_STATE_PATH, "utf8")) as {
        mailboxWatermarks?: Record<string, string>;
        messages?: Record<string, { pipeline?: Pipeline | null; notionPageId?: string | null; processedAt?: string; classification?: string }>;
      };
      fresh.mailboxWatermarks = legacy.mailboxWatermarks ?? {};
      for (const [key, m] of Object.entries(legacy.messages ?? {})) {
        fresh.messages[key] = {
          processedAt: m.processedAt ?? fresh.forwardSince,
          recorded: true,
          pipeline: m.pipeline ?? null,
          notionPageId: m.notionPageId ?? null,
          recordResult: `legacy:${m.classification ?? "?"}`,
        };
      }
      log.info("mail_triage.state_migrated", {
        mailboxes: Object.keys(fresh.mailboxWatermarks).length,
        messages: Object.keys(fresh.messages).length,
      });
    } catch {
      // no legacy state either — genuinely first run, full-history record backfill
    }
    return fresh;
  }
}

/** False if the write failed — callers must not do a write-ahead action then. */
function saveState(state: TriageState): boolean {
  if (isDryRun()) return true;
  try {
    fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
    fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
    return true;
  } catch (err) {
    log.error("mail_triage.save_state_failed", { message: errMsg(err) });
    return false;
  }
}

interface ForwardTargets {
  partners?: string;
  suppliers?: string;
  staff?: string;
  invoices?: string;
}

interface MailboxRun {
  mailbox: string;
  clean: boolean;
  inboxIds: Set<string>;
  keptConversations: Set<string>;
  latestReply: Map<string, OutlookMessage>;
  archiveBudget: { remaining: number };
}

interface RunContext {
  state: TriageState;
  targets: ForwardTargets;
  ownDomains: Set<string>;
  record: RecordContext | null; // null = Notion recording unavailable this run
  cleanMailboxes: Set<string>;
  counts: Record<string, number>;
}

const PIPELINE_TIPO: Record<Pipeline, MailTipo> = {
  partners: "parceiro",
  influencers: "influencer",
  suppliers: "fornecedor",
};

function bump(ctx: RunContext, key: string): void {
  ctx.counts[key] = (ctx.counts[key] ?? 0) + 1;
}

/** Returns false if the email still needs recording and it failed (for the watermark). */
async function triageMessage(msg: OutlookMessage, box: MailboxRun, ctx: RunContext): Promise<boolean> {
  const dryRun = isDryRun();
  const { state } = ctx;
  const key = messageKey(box.mailbox, msg.id);
  const st: MessageState = state.messages[key] ?? { processedAt: new Date().toISOString(), recorded: false };
  state.messages[key] = st;
  let categories = [...msg.categories];

  const inInbox = box.clean && box.inboxIds.has(msg.id);
  const kept = isKeptInInbox(msg, box.keptConversations);
  const noise = matchNoiseRule(msg.from.email, msg.subject);
  const fromUs = isFromOwnDomain(msg.from.email, ctx.ownDomains);
  const known = !st.recorded && ctx.record && !noise ? findExactKnownContact(msg, ctx.record) : null;

  // Is the stored verdict still good enough to decide the clean step?
  const reply = msg.conversationId ? box.latestReply.get(msg.conversationId) : undefined;
  const newerReply = reply && new Date(reply.sentDateTime) > new Date(msg.receivedDateTime) ? reply : undefined;
  const verdictFresh =
    st.verdictAt !== undefined &&
    ageInDays(st.verdictAt) < recheckAfterDays() &&
    (!newerReply || newerReply.sentDateTime === st.verdictReplyAt);
  const legacyTagFresh =
    st.verdictAt === undefined && categories.includes(TIDY_CATEGORY) && ageInDays(msg.lastModifiedDateTime) < recheckAfterDays();
  const forceArchive = inInbox && !kept && categories.includes(FEEDBACK_SHOULD_ARCHIVE_CATEGORY);
  const willClean = inInbox && !kept && !forceArchive && !noise && msg.isRead;

  // Invoice pre-filter (keywords on subject + filenames) — only in clean inboxes.
  let attachments: OutlookAttachment[] | null = null;
  const loadAttachments = async (): Promise<OutlookAttachment[]> => {
    attachments ??= msg.hasAttachments ? await outlook.getMessageAttachments(box.mailbox, msg.id) : [];
    return attachments;
  };
  const invoiceChecked =
    categories.includes(INVOICE_FORWARDED_CATEGORY) || categories.includes(INVOICE_REJECTED_CATEGORY);
  const invoiceCandidates =
    inInbox && msg.hasAttachments && !fromUs && !invoiceChecked && !noise && !st.notInvoiceByKeywords
      ? invoiceCandidateAttachments(msg.subject, await loadAttachments())
      : null;
  if (attachments !== null && invoiceCandidates === null) st.notInvoiceByKeywords = true;

  // ── 1. verdict ─────────────────────────────────────────────────────────
  const afterGoLive = msg.receivedDateTime >= state.forwardSince;
  const needVerdict =
    !noise &&
    ((!st.recorded && ctx.record !== null && !known) ||
      (willClean && !verdictFresh && !legacyTagFresh) ||
      (invoiceCandidates !== null && st.verdictAt === undefined) ||
      (afterGoLive && !fromUs && !known && st.verdictAt === undefined));

  if (needVerdict) {
    const verdict = await classifyMail({
      mailbox: box.mailbox,
      fromName: msg.from.name,
      fromEmail: msg.from.email,
      to: msg.to.map((r) => r.email),
      subject: msg.subject,
      body: msg.body,
      attachmentNames: (await loadAttachments()).map((a) => a.name),
      laterReplyBody: newerReply?.body,
    });
    if (!verdict) {
      bump(ctx, "undecided");
      log.warn("mail_triage.undecided", { mailbox: box.mailbox, messageId: msg.id, subject: msg.subject });
      return st.recorded; // nothing else happens this run; retried next run
    }
    st.tipo = verdict.tipo;
    st.needsAction = verdict.needsAction;
    st.isSupplierInvoice = verdict.isSupplierInvoice;
    st.reason = verdict.reason;
    st.verdictAt = new Date().toISOString();
    st.verdictReplyAt = newerReply?.sentDateTime;
    bump(ctx, "classified");
  }
  const tipo: MailTipo | undefined = known ? PIPELINE_TIPO[known.pipeline] : st.tipo;

  // ── 2. record in Notion ────────────────────────────────────────────────
  let recordFailed = false;
  if (!st.recorded && ctx.record) {
    try {
      let result: RecordResult | null = null;
      if (known) result = await updateKnownContact(known, msg, ctx.record);
      else if (!noise && (tipo === "parceiro" || tipo === "influencer" || tipo === "fornecedor")) {
        result = await recordNewContact(msg, tipo, ctx.record);
      }
      if (result) {
        st.recordResult = result.kind;
        if (result.kind === "updated_known" || result.kind === "created") {
          st.pipeline = result.pipeline;
          st.notionPageId = result.notionPageId;
        }
        bump(ctx, `record_${result.kind}`);
        log.info(dryRun ? "mail_triage.would_record" : "mail_triage.recorded", {
          mailbox: box.mailbox,
          messageId: msg.id,
          subject: msg.subject,
          tipo,
          result: result.kind,
          ...(result.kind === "duplicate_skipped" ? { existing: result.existing } : {}),
        });
      }
      st.recorded = true;
    } catch (err) {
      recordFailed = true;
      bump(ctx, "record_failed");
      log.error("mail_triage.record_failed", { mailbox: box.mailbox, messageId: msg.id, message: errMsg(err) });
    }
  } else if (!st.recorded && !ctx.record) {
    recordFailed = true; // recording unavailable this run — keep the watermark here
  }
  saveState(state);

  // ── 3. forward (each at most once) ─────────────────────────────────────
  const forwardOnce = async (target: string | undefined, label: string): Promise<void> => {
    if (!target || target.toLowerCase() === box.mailbox.toLowerCase()) return;
    st.forwardedTo ??= [];
    if (st.forwardedTo.includes(target)) return;
    st.forwardedTo.push(target);
    if (!saveState(state)) return; // write-ahead failed — never risk a repeat forward
    if (!dryRun) await outlook.forwardMessage(box.mailbox, msg.id, [target], `${AUTO_FORWARD_MARKER} (${label}).`);
    bump(ctx, `forward_${label}`);
    log.info(dryRun ? "mail_triage.would_forward" : "mail_triage.forwarded", {
      mailbox: box.mailbox,
      messageId: msg.id,
      subject: msg.subject,
      from: msg.from.email,
      to: target,
      kind: label,
    });
  };

  if (afterGoLive && !fromUs && !noise) {
    try {
      if (tipo === "parceiro") await forwardOnce(ctx.targets.partners, "parceria");
      if (tipo === "fornecedor" && !ctx.cleanMailboxes.has(box.mailbox)) {
        await forwardOnce(ctx.targets.suppliers, "fornecedor");
      }
      if (tipo === "candidatura") await forwardOnce(ctx.targets.staff, "candidatura");
    } catch (err) {
      bump(ctx, "forward_failed");
      log.error("mail_triage.forward_failed", { mailbox: box.mailbox, messageId: msg.id, message: errMsg(err) });
    }
  }

  // Supplier invoices: keyword pre-filter AND the verdict must both agree.
  if (invoiceCandidates && st.verdictAt !== undefined && ctx.targets.invoices) {
    try {
      if (st.isSupplierInvoice) {
        // Marker first: if it can't be written, this throws before forwarding.
        categories = [...categories, INVOICE_FORWARDED_CATEGORY];
        if (!dryRun) {
          await outlook.setMessageCategories(box.mailbox, msg.id, categories);
          await outlook.forwardMessage(box.mailbox, msg.id, [ctx.targets.invoices], `${AUTO_FORWARD_MARKER} (fatura de fornecedor).`);
        }
        bump(ctx, "forward_fatura");
        log.info(dryRun ? "mail_triage.would_forward" : "mail_triage.forwarded", {
          mailbox: box.mailbox,
          messageId: msg.id,
          subject: msg.subject,
          from: msg.from.email,
          to: ctx.targets.invoices,
          kind: "fatura",
          attachment: invoiceCandidates.map((a) => a.name).join(", "),
        });
      } else {
        categories = [...categories, INVOICE_REJECTED_CATEGORY];
        if (!dryRun) await outlook.setMessageCategories(box.mailbox, msg.id, categories);
      }
    } catch (err) {
      bump(ctx, "forward_failed");
      log.error("mail_triage.invoice_failed", { mailbox: box.mailbox, messageId: msg.id, message: errMsg(err) });
    }
  }

  // ── 4. clean (clean inboxes only) ──────────────────────────────────────
  if (!inInbox) return !recordFailed;
  if (kept) {
    bump(ctx, "kept_by_founder");
    return !recordFailed;
  }

  const archive = async (event: string, extra: Record<string, unknown>): Promise<void> => {
    if (!dryRun) await outlook.archiveMessage(box.mailbox, msg.id);
    log.info(dryRun ? "mail_triage.would_archive" : event, {
      mailbox: box.mailbox,
      messageId: msg.id,
      subject: msg.subject,
      from: msg.from.email,
      ...extra,
    });
  };

  try {
    if (forceArchive) {
      await archive("mail_triage.feedback_should_have_archived", {
        receivedDateTime: msg.receivedDateTime,
        webLink: msg.webLink,
        bodyPreview: msg.bodyPreview,
      });
      bump(ctx, "archived_by_founder");
    } else if (!msg.isRead) {
      bump(ctx, "unread");
    } else if (noise) {
      await archive("mail_triage.auto_archived", { rule: noise });
      bump(ctx, "archived_noise");
    } else if (legacyTagFresh || st.needsAction !== false) {
      // Needs action (or no usable verdict) — leave it, visibly tagged.
      if (!categories.includes(TIDY_CATEGORY) && !dryRun) {
        await outlook.setMessageCategories(box.mailbox, msg.id, [...categories, TIDY_CATEGORY]);
      }
      bump(ctx, "left");
    } else if (box.archiveBudget.remaining <= 0) {
      // Over the cap: untouched and untagged, reconsidered next run.
      log.warn("mail_triage.archive_capped", { mailbox: box.mailbox, messageId: msg.id, subject: msg.subject });
      bump(ctx, "capped");
    } else {
      box.archiveBudget.remaining--;
      await archive("mail_triage.archived", { reason: st.reason, classifiedFromReply: Boolean(st.verdictReplyAt) });
      bump(ctx, "archived");
    }
  } catch (err) {
    bump(ctx, "clean_failed");
    log.error("mail_triage.clean_failed", { mailbox: box.mailbox, messageId: msg.id, message: errMsg(err) });
  }
  return !recordFailed;
}

export async function run(): Promise<void> {
  if (!outlook.isAuthenticated()) {
    log.warn("mail_triage.disabled", { reason: "outlook not authenticated" });
    return;
  }
  const cleanMailboxes = list(process.env.OUTLOOK_TIDY_MAILBOXES);
  const recordMailboxes = list(process.env.OUTLOOK_MAILBOXES);
  const mailboxes = [...new Set(["me", ...recordMailboxes, ...cleanMailboxes])];
  const targets: ForwardTargets = {
    partners: process.env.OUTLOOK_PARTNERSHIP_FORWARD_TO || undefined,
    suppliers: process.env.OUTLOOK_SUPPLIERS_FORWARD_TO || undefined,
    staff: process.env.OUTLOOK_STAFF_FORWARD_TO || undefined,
    invoices: process.env.OUTLOOK_INVOICES_FORWARD_TO || undefined,
  };

  let myEmail = "";
  let record: RecordContext | null = null;
  try {
    myEmail = await outlook.getMyEmail();
  } catch (err) {
    log.error("mail_triage.get_my_email_failed", { message: errMsg(err) });
  }
  const ownDomains = new Set([domainOf(myEmail), ...mailboxes.map(domainOf)].filter(Boolean));

  if (process.env.NOTION_PARTNER_DB_ID && process.env.NOTION_INFLUENCER_DB_ID) {
    try {
      const [partners, influencers, suppliers] = await Promise.all([
        notion.getAllPartnerContacts(),
        notion.getAllInfluencerContacts(),
        process.env.NOTION_SUPPLIER_DB_ID ? notion.getAllSupplierContacts() : Promise.resolve([] as KnownContact[]),
      ]);
      record = {
        ownDomains,
        dryRun: isDryRun(),
        lookups: {
          partners: buildContactLookups(partners, ownDomains),
          influencers: buildContactLookups(influencers, ownDomains),
          suppliers: buildContactLookups(suppliers, ownDomains),
        },
      };
    } catch (err) {
      // Cleaning and forwarding still run; nothing gets marked recorded and
      // the watermarks hold, so recording catches up next run.
      log.error("mail_triage.notion_lookup_failed", { message: errMsg(err) });
    }
  }

  const state = loadState();
  const ctx: RunContext = {
    state,
    targets,
    ownDomains,
    record,
    cleanMailboxes: new Set(cleanMailboxes),
    counts: {},
  };

  for (const mailbox of mailboxes) {
    let recent: OutlookMessage[];
    try {
      recent = await outlook.searchMailboxMessages(mailbox, { sinceISO: state.mailboxWatermarks[mailbox] });
    } catch (err) {
      log.error("mail_triage.mailbox_fetch_failed", { mailbox, message: errMsg(err) });
      bump(ctx, "errors");
      continue;
    }

    let clean = ctx.cleanMailboxes.has(mailbox);
    let inbox: OutlookMessage[] = [];
    const latestReply = new Map<string, OutlookMessage>();
    if (clean) {
      try {
        inbox = await outlook.listInboxMessages(mailbox);
      } catch (err) {
        log.error("mail_triage.inbox_fetch_failed", { mailbox, message: errMsg(err) });
        clean = false; // record/forward still run for this mailbox
      }
      try {
        for (const s of await outlook.listSentMessages(mailbox)) {
          if (!s.conversationId || isOwnAutoForward(s, targets.invoices)) continue;
          const prev = latestReply.get(s.conversationId);
          if (!prev || new Date(s.sentDateTime) > new Date(prev.sentDateTime)) latestReply.set(s.conversationId, s);
        }
      } catch (err) {
        log.warn("mail_triage.sent_list_failed", { mailbox, message: errMsg(err) });
      }
    }

    const byId = new Map<string, OutlookMessage>();
    for (const m of [...recent, ...inbox]) byId.set(m.id, m);
    const all = [...byId.values()];
    const box: MailboxRun = {
      mailbox,
      clean,
      inboxIds: new Set(inbox.map((m) => m.id)),
      keptConversations: keptConversationIds(all),
      latestReply,
      archiveBudget: { remaining: maxArchivesPerRun() },
    };

    let minFailed: string | null = null;
    let maxSeen: string | null = null;
    const recentIds = new Set(recent.map((m) => m.id));
    for (const msg of all) {
      let ok = true;
      try {
        ok = await triageMessage(msg, box, ctx);
      } catch (err) {
        ok = false;
        bump(ctx, "errors");
        log.error("mail_triage.message_failed", { mailbox, messageId: msg.id, message: errMsg(err) });
      }
      if (!recentIds.has(msg.id)) continue; // inbox backlog doesn't move the watermark
      if (maxSeen === null || msg.receivedDateTime > maxSeen) maxSeen = msg.receivedDateTime;
      if (!ok && (minFailed === null || msg.receivedDateTime < minFailed)) minFailed = msg.receivedDateTime;
    }
    const watermark = minFailed ?? maxSeen;
    if (watermark) {
      state.mailboxWatermarks[mailbox] = watermark;
      saveState(state);
    }
  }

  log.info("mail_triage.done", { mailboxes, dryRun: isDryRun(), ...ctx.counts });
}
