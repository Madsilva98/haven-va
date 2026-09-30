/**
 * "Record what needs recording in Notion" — the Partner Pipeline /
 * Influencer Pipeline / Fornecedores half of the mail-triage cron
 * (src/crons/mail-triage.ts). Moved here unchanged from the retired
 * sync-partnerships cron (2026-09-30); every founder rule it carried still
 * holds:
 *
 *   1. Known contact, exact email match (src/lib/outlook-contact-matching.ts)
 *      → update that page directly (Último contacto + enrichment). A domain
 *      match only proves "same organization" — never auto-updated, only a
 *      dedup hint for step 3.
 *   2. No external party (a founder re-sharing a thread internally) → skip,
 *      never name a page after a founder.
 *   3. Dedup before create (fuzzy name match, or the domain-hint contact) →
 *      skip, never auto-merge; a human decides.
 *   4. Create + enrich (src/lib/entity-enrichment.ts) + Último contacto.
 *   Fornecedores is skipped gracefully if NOTION_SUPPLIER_DB_ID isn't set.
 *
 * What changed: the classification now comes from the single mail-triage
 * verdict (src/lib/mail-verdict.ts) instead of its own classifier call, and
 * forwarding/archiving is no longer done here — the cron does all of that
 * in one place, after recording.
 */

import {
  enrichInfluencerPageFromText,
  enrichPartnerPageFromText,
  enrichSupplierPageFromText,
} from "./entity-enrichment.js";
import type { OutlookMessage } from "./outlook.js";
import {
  guessExternalParty,
  matchKnownContact,
  type ContactLookups,
  type KnownContact,
} from "./outlook-contact-matching.js";
import * as notion from "../notion.js";

export type Pipeline = "partners" | "influencers" | "suppliers";

export interface RecordContext {
  ownDomains: Set<string>;
  lookups: Record<Pipeline, ContactLookups>;
  dryRun: boolean;
}

export interface ExactKnownContact {
  pipeline: Pipeline;
  contact: KnownContact;
}

export type RecordResult =
  | { kind: "updated_known"; pipeline: Pipeline; notionPageId: string }
  | { kind: "created"; pipeline: Pipeline; notionPageId: string | null }
  | { kind: "duplicate_skipped"; pipeline: Pipeline; existing: string }
  | { kind: "no_external_party" }
  | { kind: "supplier_not_configured" };

// Same priority order the old cron used: partner, then influencer, then supplier.
const PIPELINES: Pipeline[] = ["partners", "influencers", "suppliers"];

export function findExactKnownContact(msg: OutlookMessage, ctx: RecordContext): ExactKnownContact | null {
  for (const pipeline of PIPELINES) {
    const match = matchKnownContact(msg.from, msg.to, ctx.ownDomains, ctx.lookups[pipeline]);
    if (match?.matchBasis === "exact_email") return { pipeline, contact: match.contact };
  }
  return null;
}

export function formatOrigem(msg: OutlookMessage): string {
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

/** Throws on a Notion write failure — the caller leaves the email unrecorded to retry next run. */
export async function updateKnownContact(
  known: ExactKnownContact,
  msg: OutlookMessage,
  ctx: RecordContext,
): Promise<RecordResult> {
  const text = `${msg.subject}\n${msg.body}`;
  const { contact, pipeline } = known;
  if (!ctx.dryRun) {
    if (pipeline === "partners") {
      await notion.updatePartnerFields(contact.id, { ultimoContacto: msg.receivedDateTime });
      await enrichPartnerPageFromText(contact.id, text);
    } else if (pipeline === "influencers") {
      await enrichInfluencerPageFromText(contact.id, text, contact.name, { ultimoContacto: msg.receivedDateTime });
    } else {
      await notion.updateSupplierFields(contact.id, { ultimoContacto: msg.receivedDateTime });
      await enrichSupplierPageFromText(contact.id, text);
    }
  }
  return { kind: "updated_known", pipeline, notionPageId: contact.id };
}

/** For an email the verdict called parceiro / influencer / fornecedor. Throws on a write failure. */
export async function recordNewContact(
  msg: OutlookMessage,
  tipo: "parceiro" | "influencer" | "fornecedor",
  ctx: RecordContext,
): Promise<RecordResult> {
  const text = `${msg.subject}\n${msg.body}`;
  const pipeline: Pipeline = tipo === "parceiro" ? "partners" : tipo === "influencer" ? "influencers" : "suppliers";

  const externalParty = guessExternalParty(msg.from, msg.to, ctx.ownDomains);
  if (!externalParty) return { kind: "no_external_party" };
  if (pipeline === "suppliers" && !process.env.NOTION_SUPPLIER_DB_ID) return { kind: "supplier_not_configured" };

  // A domain match is only a dedup hint, never an automatic update.
  const domainHint = matchKnownContact(msg.from, msg.to, ctx.ownDomains, ctx.lookups[pipeline]);
  const existing = domainHint
    ? { id: domainHint.contact.id, title: domainHint.contact.name }
    : await notion.findPageInDb(pipeline, externalParty.name);
  if (existing) return { kind: "duplicate_skipped", pipeline, existing: existing.title };

  if (ctx.dryRun) return { kind: "created", pipeline, notionPageId: null };

  if (pipeline === "partners") {
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
    return { kind: "created", pipeline, notionPageId: pageId };
  }

  if (pipeline === "influencers") {
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
    return { kind: "created", pipeline, notionPageId: pageId };
  }

  const pageId = await notion.createSupplier(
    externalParty.name,
    "Unassigned",
    formatOrigem(msg),
    "Email",
    msg.receivedDateTime,
    "A avaliar",
    externalParty.email || null,
  );
  await enrichSupplierPageFromText(pageId, text);
  return { kind: "created", pipeline, notionPageId: pageId };
}
