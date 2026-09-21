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
import { isStudioSupabaseAvailable } from "../lib/studio-supabase.js";
import { sendGroupMessage } from "../lib/telegram.js";
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
  if (!isStudioSupabaseAvailable()) {
    log.debug("leads_intro_pack.skipped", { reason: "studio_supabase_not_configured" });
    return;
  }

  let candidates: Awaited<ReturnType<typeof findUnconvertedIntroPacks>>;
  try {
    candidates = await findUnconvertedIntroPacks();
  } catch (err) {
    log.error("leads_intro_pack.fetch_failed", { message: errMsg(err) });
    return;
  }

  const created: NewLeadSummary[] = [];

  for (const c of candidates) {
    try {
      // findLeadByEmailAny, not findLeadByEmail: an Intro Pack candidate
      // re-derives every Monday for as long as the pack stays unconverted,
      // so a row the founder marked Perdido (deliberately left un-archived
      // by leads-reconcile.ts for exactly this reason) must still block
      // recreation — findLeadByEmail's open-only filter would ignore it and
      // silently undo her Perdido call (broke in production 2026-09-21).
      const existing = await notion.findLeadByEmailAny(c.email);
      if (existing) continue; // already a lead (open, Perdido, or Convertido) for this person

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
    log.info("leads_intro_pack.no_new", { totalCandidates: candidates.length });
    return;
  }
  try {
    const messageId = await sendGroupMessage(message);
    log.info("leads_intro_pack.posted", { messageId, count: created.length });
  } catch (err) {
    log.error("leads_intro_pack.send_failed", { message: errMsg(err) });
  }
}
