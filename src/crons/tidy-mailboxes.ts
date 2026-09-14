/**
 * Fully automatic mailbox tidying for configured Outlook shared inboxes
 * (e.g. geral@, hello@): forwards invoice-looking attachments to a
 * dedicated finance address, then archives any remaining thread that a
 * Haiku classifier judges resolved / not needing a reply.
 *
 * No human review step — this is deliberately unattended (unlike the
 * Outlook partnerships sync, which always requires review before writing
 * anything). See docs/knowledge-base/tidy-mailboxes.md for the design,
 * the fail-safe defaults, and how to audit what it's done.
 *
 * Unread messages are untouched entirely — no classification, no invoice
 * forward, no category tag — until a human has actually opened them. Once
 * read, they're picked up fresh on the very next run.
 *
 * Gracefully disabled if OUTLOOK_TIDY_MAILBOXES or the Microsoft/Outlook
 * env vars aren't set — same pattern as every other optional feature here.
 *
 * Set TIDY_MAILBOXES_DRY_RUN=true to run the full classification/detection
 * logic against real mailboxes without actually archiving or forwarding —
 * logs tidy_mailboxes.would_archive/would_forward instead. Use this to
 * sanity-check behavior on real inbox content before trusting it live.
 *
 * Cost note: every message left in the Inbox (needs a reply) gets tagged
 * with the TIDY_CATEGORY Outlook category and is skipped on every
 * subsequent run without calling Claude or re-forwarding anything — this
 * cron only ever pays for genuinely new arrivals, not for re-litigating
 * the same still-open thread every single run. On top of that,
 * known pure-notification senders (DEFAULT_AUTO_ARCHIVE_SENDERS, extend via
 * TIDY_MAILBOXES_AUTO_ARCHIVE_SENDERS) skip the Haiku call AND the invoice
 * check entirely — archived on sender match alone.
 */

import { classifyMailboxThread } from "../bot/classify-mailbox-thread.js";
import { log } from "../lib/log.js";
import * as outlook from "../lib/outlook.js";
import type { OutlookAttachment, OutlookMessage } from "../lib/outlook.js";

// Tags a message once it's been checked and left in the Inbox (needs a
// reply, or errored and fell back to needs-action) so the next run skips
// it entirely — no re-classification, and critically, no re-forwarding an
// invoice-looking attachment every single run it sits there waiting for a
// human. Without this, the cron re-pays the full LLM cost (and duplicates
// any forward) for every message still open, for as long as it stays open
// — the real cost driver, not the one-time backlog of a first run.
const TIDY_CATEGORY = "TidyBot: revisto";

const INVOICE_WORDS = ["fatura", "invoice", "recibo", "receipt"];

// Plain substring matching, not a \b-bounded regex — filenames commonly use
// underscores ("fatura_setembro.pdf"), and \b doesn't count "_" as a
// boundary (it's a word character), so a regex missed exactly the filename
// shape real invoices show up with. Caught by testing before this shipped.
function mentionsInvoice(text: string): boolean {
  const lower = text.toLowerCase();
  return INVOICE_WORDS.some((w) => lower.includes(w));
}

function isPdfOrImage(contentType: string): boolean {
  return /^application\/pdf$/i.test(contentType) || /^image\//i.test(contentType);
}

/**
 * Returns the attachment(s) that made this look like an invoice, or null.
 * Requires a PDF/image attachment AND (its filename OR the email's
 * subject/body) mentioning fatura/invoice/recibo/receipt — attachment type
 * alone isn't enough, to avoid forwarding every PDF proposal/contract.
 */
function invoiceAttachments(
  subject: string,
  body: string,
  attachments: OutlookAttachment[],
): OutlookAttachment[] | null {
  const candidates = attachments.filter((a) => isPdfOrImage(a.contentType));
  if (candidates.length === 0) return null;
  const nameMatch = candidates.some((a) => mentionsInvoice(a.name));
  const contextMatch = mentionsInvoice(subject) || mentionsInvoice(body.slice(0, 1000));
  return nameMatch || contextMatch ? candidates : null;
}

function configuredMailboxes(): string[] {
  return (process.env.OUTLOOK_TIDY_MAILBOXES ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

// Exact sender addresses known to send nothing but pure logistics
// notifications (never an invoice, never anything actionable) — skips both
// the invoice check and the Haiku call entirely for these. Deliberately
// exact addresses, not whole domains: a domain like amazon.es also sends
// account/billing mail that might need a look, but its dedicated shipping-
// notification addresses (confirmar-envio@, auto-confirm@) never do.
// Extend via TIDY_MAILBOXES_AUTO_ARCHIVE_SENDERS, comma-separated.
const DEFAULT_AUTO_ARCHIVE_SENDERS = [
  "no-reply@notifications.cttexpress.com",
  "no-reply@cttexpresso.pt",
  "no-reply@correosexpress.com",
  "no-reply@sendcloud.com",
  "noreply@gls-portugal.com",
  "confirmar-envio@amazon.es",
  "auto-confirm@amazon.es",
  "devolucion@amazon.es",
  // Wellhub's dedicated marketing/nurture-drip addresses — every message
  // seen from these is an automated signup nag ("assinatura", "contrato
  // pronto", "falta pouco para ativar", etc.), unlike support@wellhub.com
  // which also carries the real partnership negotiation thread. Subject
  // keyword matching (AUTO_ARCHIVE_RULES below) missed several of these
  // because the wording varies ("assine" vs "assinatura" vs no sign-related
  // word at all) — sender-address matching is more robust here than trying
  // to enumerate every phrasing.
  "partners.signup@wellhub.com",
  "globalpartners@email.wellhub.com",
];

function autoArchiveSenders(): Set<string> {
  const extra = (process.env.TIDY_MAILBOXES_AUTO_ARCHIVE_SENDERS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return new Set([...DEFAULT_AUTO_ARCHIVE_SENDERS, ...extra]);
}

interface AutoArchiveRule {
  description: string;
  senderContainsAny: string[];
  subjectContainsAny: string[];
}

// Sender+subject combo rules — for senders that ALSO send things that
// genuinely need a look (e.g. support@wellhub.com sends both these signup
// nags AND the real Wellhub partnership negotiation thread), so the sender
// alone isn't a safe enough signal — the subject narrows it to only the
// specific automated pattern. All conditions in a rule must match (sender
// AND subject); any one rule matching is enough to archive.
const AUTO_ARCHIVE_RULES: AutoArchiveRule[] = [
  {
    description: "Wellhub/ClassPass automated signup reminder",
    senderContainsAny: ["wellhub.com", "gympass.com", "classpass.com"],
    subjectContainsAny: ["assine"],
  },
  {
    description: "Kenko Luna approvals pending notification",
    senderContainsAny: ["bookeeapp.com"],
    subjectContainsAny: ["luna approvals pending"],
  },
  {
    description: "Kenko AI new-message notification",
    senderContainsAny: ["bookeeapp.com"],
    subjectContainsAny: ["new message from"],
  },
];

function matchingAutoArchiveRule(fromEmail: string, subject: string): AutoArchiveRule | null {
  const from = fromEmail.toLowerCase();
  const subj = subject.toLowerCase();
  for (const rule of AUTO_ARCHIVE_RULES) {
    const senderMatch = rule.senderContainsAny.some((s) => from.includes(s.toLowerCase()));
    const subjectMatch = rule.subjectContainsAny.some((s) => subj.includes(s.toLowerCase()));
    if (senderMatch && subjectMatch) return rule;
  }
  return null;
}

function isDryRun(): boolean {
  return process.env.TIDY_MAILBOXES_DRY_RUN === "true";
}

interface MessageOutcome {
  forwarded: boolean;
  archived: boolean;
  autoArchived: boolean;
}

/**
 * Classification ALWAYS runs, and is the only thing that decides whether
 * the original stays in the Inbox — an invoice-looking attachment never
 * bypasses it. Forwarding a copy to finance and archiving the original are
 * independent decisions: a customer complaint that happens to attach a
 * receipt still gets forwarded (finance gets their copy) but is NOT
 * archived, because it still needs a reply.
 *
 * This wasn't the original design — a first version treated "has an
 * invoice attachment" as a shortcut that skipped classification entirely
 * and always archived. A dry run against real mailboxes caught it
 * archiving a customer's "Issues with 10 day pass" complaint and a
 * contract awaiting signature, both because they happened to have a PDF
 * attached. Fixed 2026-09-14 before this ever ran for real — see
 * docs/knowledge-base/tidy-mailboxes.md.
 */
async function handleMessage(
  mailbox: string,
  msg: OutlookMessage,
  forwardTo: string,
): Promise<MessageOutcome> {
  const dryRun = isDryRun();
  const outcome: MessageOutcome = { forwarded: false, archived: false, autoArchived: false };

  if (autoArchiveSenders().has(msg.from.email.toLowerCase())) {
    if (!dryRun) {
      await outlook.archiveMessage(mailbox, msg.id);
    }
    log.info(dryRun ? "tidy_mailboxes.would_auto_archive" : "tidy_mailboxes.auto_archived", {
      mailbox,
      messageId: msg.id,
      subject: msg.subject,
      from: msg.from.email,
      rule: "exact sender match",
    });
    outcome.archived = true;
    outcome.autoArchived = true;
    return outcome;
  }

  const matchedRule = matchingAutoArchiveRule(msg.from.email, msg.subject);
  if (matchedRule) {
    if (!dryRun) {
      await outlook.archiveMessage(mailbox, msg.id);
    }
    log.info(dryRun ? "tidy_mailboxes.would_auto_archive" : "tidy_mailboxes.auto_archived", {
      mailbox,
      messageId: msg.id,
      subject: msg.subject,
      from: msg.from.email,
      rule: matchedRule.description,
    });
    outcome.archived = true;
    outcome.autoArchived = true;
    return outcome;
  }

  if (msg.hasAttachments) {
    const attachments = await outlook.getMessageAttachments(mailbox, msg.id);
    const matched = invoiceAttachments(msg.subject, msg.body, attachments);
    if (matched) {
      if (!dryRun) {
        await outlook.forwardMessage(
          mailbox,
          msg.id,
          [forwardTo],
          "Reencaminhado automaticamente (parece conter uma fatura).",
        );
      }
      log.info(dryRun ? "tidy_mailboxes.would_forward" : "tidy_mailboxes.invoice_forwarded", {
        mailbox,
        messageId: msg.id,
        subject: msg.subject,
        from: msg.from.email,
        attachment: matched.map((a) => a.name).join(", "),
        forwardedTo: forwardTo,
      });
      outcome.forwarded = true;
    }
  }

  const { needsAction, reason } = await classifyMailboxThread({
    mailbox,
    subject: msg.subject,
    fromName: msg.from.name,
    fromEmail: msg.from.email,
    body: msg.body,
  });

  if (needsAction) {
    if (!dryRun) {
      await outlook.setMessageCategories(mailbox, msg.id, [...msg.categories, TIDY_CATEGORY]);
    }
    log.debug("tidy_mailboxes.left_in_inbox", {
      mailbox,
      messageId: msg.id,
      subject: msg.subject,
      reason,
    });
    return outcome;
  }

  if (!dryRun) {
    await outlook.archiveMessage(mailbox, msg.id);
  }
  log.info(dryRun ? "tidy_mailboxes.would_archive" : "tidy_mailboxes.archived", {
    mailbox,
    messageId: msg.id,
    subject: msg.subject,
    from: msg.from.email,
    reason,
  });
  outcome.archived = true;
  return outcome;
}

export async function run(): Promise<void> {
  const mailboxes = configuredMailboxes();
  const forwardTo = process.env.OUTLOOK_INVOICES_FORWARD_TO;

  if (mailboxes.length === 0) {
    log.debug("tidy_mailboxes.disabled", { reason: "OUTLOOK_TIDY_MAILBOXES not set" });
    return;
  }
  if (!forwardTo) {
    log.warn("tidy_mailboxes.disabled", { reason: "OUTLOOK_INVOICES_FORWARD_TO not set" });
    return;
  }
  if (!outlook.isAuthenticated()) {
    log.warn("tidy_mailboxes.disabled", { reason: "outlook not authenticated" });
    return;
  }

  const counts = { forwarded: 0, archived: 0, autoArchived: 0, left: 0, skipped: 0, unread: 0, errors: 0 };

  for (const mailbox of mailboxes) {
    let messages: OutlookMessage[];
    try {
      messages = await outlook.listInboxMessages(mailbox);
    } catch (err) {
      log.error("tidy_mailboxes.list_failed", {
        mailbox,
        message: err instanceof Error ? err.message : String(err),
      });
      counts.errors++;
      continue;
    }

    for (const msg of messages) {
      // Untouched until a human has actually opened it — no classification,
      // no invoice-forward, no TIDY_CATEGORY tag. Once read, it's picked up
      // fresh on the next run like any other message. This is deliberate:
      // archiving (or even just judging) something nobody has seen yet is a
      // different, riskier thing than archiving something a founder already
      // looked at, even if an LLM would judge the content the same either way.
      if (!msg.isRead) {
        counts.unread++;
        continue;
      }
      if (msg.categories.includes(TIDY_CATEGORY)) {
        counts.skipped++;
        continue;
      }
      try {
        const outcome = await handleMessage(mailbox, msg, forwardTo);
        if (outcome.forwarded) counts.forwarded++;
        if (outcome.autoArchived) counts.autoArchived++;
        else if (outcome.archived) counts.archived++;
        if (!outcome.archived) counts.left++;
      } catch (err) {
        log.error("tidy_mailboxes.message_failed", {
          mailbox,
          messageId: msg.id,
          subject: msg.subject,
          message: err instanceof Error ? err.message : String(err),
        });
        counts.errors++;
      }
    }
  }

  log.info("tidy_mailboxes.done", { mailboxes, dryRun: isDryRun(), ...counts });
}
