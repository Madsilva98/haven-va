/**
 * Fixed, non-AI rules for the mail-triage cron (src/crons/mail-triage.ts),
 * moved unchanged from the retired tidy-mailboxes cron (2026-09-30). The
 * history behind each one is in docs/knowledge-base/tidy-mailboxes.md.
 */

import type { OutlookMessage } from "./outlook.js";

// Left on a message the cron judged still needs a reply — visible in
// Outlook. (The skip-memory itself now lives in the triage state file.)
export const TIDY_CATEGORY = "TidyBot: revisto";

// Founder's "should have archived" override — archives right away (unless
// the "não arquivar" keep tag is also on the thread, which wins).
export const FEEDBACK_SHOULD_ARCHIVE_CATEGORY = "TidyBot: devia ter arquivado";

// Permanent invoice markers: a message goes to faturas@ at most once and
// is never re-judged (2026-09-28, the re-forwarded "Proposta de orçamento").
export const INVOICE_FORWARDED_CATEGORY = "TidyBot: fatura enviada";
export const INVOICE_REJECTED_CATEGORY = "TidyBot: não é fatura";

// The comment every automatic forward carries — also how our own forwards
// are kept out of the "the Haven already replied" check.
export const AUTO_FORWARD_MARKER = "Reencaminhado automaticamente";

// Exact sender addresses that only ever send pure logistics/nurture
// notifications — never an invoice, never anything to record or answer.
// Exact addresses, never whole domains (amazon.es also sends real billing
// mail; ikea.com / leroymerlin.pt send real invoices — never add those).
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
  // Wellhub's marketing/nurture addresses — unlike support@wellhub.com,
  // which also carries the real partnership negotiation thread.
  "partners.signup@wellhub.com",
  "globalpartners@email.wellhub.com",
];

interface NoiseRule {
  description: string;
  senderContainsAny: string[];
  subjectContainsAny: string[];
}

// Sender+subject combos, for senders that ALSO send things that need a look.
const NOISE_RULES: NoiseRule[] = [
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

/** A description of the matching noise rule, or null. Noise skips the AI call entirely. */
export function matchNoiseRule(fromEmail: string, subject: string): string | null {
  const from = fromEmail.toLowerCase();
  const extra = (process.env.TIDY_MAILBOXES_AUTO_ARCHIVE_SENDERS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if ([...DEFAULT_AUTO_ARCHIVE_SENDERS, ...extra].includes(from)) return "exact sender match";
  const subj = subject.toLowerCase();
  for (const rule of NOISE_RULES) {
    if (
      rule.senderContainsAny.some((s) => from.includes(s)) &&
      rule.subjectContainsAny.some((s) => subj.includes(s))
    ) {
      return rule.description;
    }
  }
  return null;
}

/** True if the sender's domain is one of the Haven's own domains — i.e. we sent it. */
export function isFromOwnDomain(fromEmail: string, ownDomains: Set<string>): boolean {
  const at = fromEmail.lastIndexOf("@");
  return at !== -1 && ownDomains.has(fromEmail.slice(at + 1).toLowerCase());
}

/**
 * A Sent Items message that is one of our own automatic forwards, not a
 * real reply. Recognised by the marker every automatic forward carries —
 * NOT by "addressed to a forward target", since geral@ is now a target
 * (suppliers) and genuine replies can be addressed to it. The one
 * recipient check kept is the invoices address, which never gets replies.
 */
export function isOwnAutoForward(sent: OutlookMessage, invoicesTarget: string | undefined): boolean {
  const invoices = invoicesTarget?.toLowerCase();
  return (
    sent.body.includes(AUTO_FORWARD_MARKER) ||
    (invoices !== undefined && sent.to.some((r) => r.email.toLowerCase() === invoices))
  );
}

export function recheckAfterDays(): number {
  const raw = Number(process.env.TIDY_MAILBOXES_RECHECK_AFTER_DAYS);
  return Number.isFinite(raw) && raw > 0 ? raw : 7;
}

export function ageInDays(iso: string, now = Date.now()): number {
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? Number.POSITIVE_INFINITY : (now - t) / (1000 * 60 * 60 * 24);
}

// Max AI-judged archives per clean mailbox per run (founder-approved
// 2026-09-29) — the fixed noise rules and the founder's own tag don't count.
export function maxArchivesPerRun(): number {
  const raw = Number(process.env.TIDY_MAILBOXES_MAX_ARCHIVES_PER_RUN);
  return Number.isFinite(raw) && raw > 0 ? raw : 30;
}
