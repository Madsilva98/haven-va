/**
 * Weekly scan for intro packs that finished at least 21 days ago (the
 * empirically validated day — see src/lib/intro-pack-conversion.ts) with
 * no conversion since. Writes into the same "Leads a contactar" Notion DB
 * as the email pipeline (Canal = "Intro Pack"), since the founder's goal
 * here — ask for feedback, try to reconvert — is the same "someone to
 * follow up with" list, not a separate tracker.
 */

import { log } from "../lib/log.js";
import { describePostExpiryVisit, findUnconvertedIntroPacks } from "../lib/intro-pack-conversion.js";
import { isStudioDbAvailable } from "../lib/studio-db.js";
import { sendGroupMessageWithSource } from "../lib/pulse-source.js";
import { PULSE_VIEW } from "../lib/pulse-views.js";
import { formatLeadsDigest, type NewLeadSummary } from "../messages/leads.js";
import * as notion from "../notion.js";

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function run(): Promise<void> {
  if (!process.env.NOTION_LEADS_DB_ID) {
    log.debug("leads_intro_pack.skipped", { reason: "NOTION_LEADS_DB_ID not set" });
    return;
  }
  if (!isStudioDbAvailable()) {
    log.debug("leads_intro_pack.skipped", { reason: "studio_db_not_configured" });
    return;
  }

  let candidates: Awaited<ReturnType<typeof findUnconvertedIntroPacks>>["candidates"];
  let asOf: string | null;
  try {
    ({ candidates, asOf } = await findUnconvertedIntroPacks());
  } catch (err) {
    log.error("leads_intro_pack.fetch_failed", { message: errMsg(err) });
    return;
  }

  const created: NewLeadSummary[] = [];
  let skippedExisting = 0;

  for (const c of candidates) {
    try {
      // findLeadByEmailAny, not findLeadByEmail: an Intro Pack candidate
      // re-derives every Monday for as long as the pack stays unconverted,
      // so a row the founder marked Perdido (deliberately left un-archived
      // by leads-reconcile.ts for exactly this reason) must still block
      // recreation — findLeadByEmail's open-only filter would ignore it and
      // silently undo her Perdido call (broke in production 2026-09-21).
      // Scoped to canal: "Intro Pack" so a closed lead on a different
      // channel (Email/WhatsApp/Instagram) that hasn't been archived yet
      // can't false-positive block a legitimate new Intro Pack lead.
      const existing = await notion.findLeadByEmailAny(c.email, "Intro Pack");
      if (existing) {
        skippedExisting++;
        log.debug("leads_intro_pack.skipped_existing", { email: c.email, estado: existing.estado });
        continue; // already a lead (open, Perdido, or Convertido) for this person
      }

      const postExpiryNote = describePostExpiryVisit(c);
      const motivo = `${c.packName} — terminou há ${c.daysSinceExpiry} dias, sem converter para mensalidade${
        postExpiryNote ? ` — ${postExpiryNote}` : ""
      }`;
      const origem = `Intro pack "${c.packName}" terminado a ${c.expiresAt.toLocaleDateString("pt-PT", { timeZone: "Europe/Lisbon" })}`;

      await notion.createLead(c.name, c.email, "Intro Pack", motivo, "N/A", origem, {
        telefone: c.phone,
        pack: c.packName,
        ultimaVisita: c.lastVisit ? c.lastVisit.toISOString() : null,
        nVisitas: c.visitCount,
      });
      created.push({ nome: c.name, canal: "Intro Pack" });
    } catch (err) {
      log.error("leads_intro_pack.write_failed", { email: c.email, message: errMsg(err) });
    }
  }

  const message = formatLeadsDigest(created);
  if (!message) {
    log.info("leads_intro_pack.no_new", { totalCandidates: candidates.length, skippedExisting });
    return;
  }
  try {
    const messageId = await sendGroupMessageWithSource(
      message,
      [PULSE_VIEW.introPurchase, PULSE_VIEW.introConversion, PULSE_VIEW.memberActivity],
      asOf,
    );
    log.info("leads_intro_pack.posted", { messageId, count: created.length, skippedExisting });
  } catch (err) {
    log.error("leads_intro_pack.send_failed", { message: errMsg(err) });
  }
}
