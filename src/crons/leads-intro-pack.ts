/**
 * Weekly scan for intro packs that finished at least 21 days ago (the
 * empirically validated day — see src/lib/intro-pack-conversion.ts) with
 * no conversion since. Writes into the same "Leads a contactar" Notion DB
 * as the email pipeline (Canal = "Intro Pack"), since the founder's goal
 * here — ask for feedback, try to reconvert — is the same "someone to
 * follow up with" list, not a separate tracker.
 *
 * Every unconverted candidate still gets a Notion lead row created,
 * however overdue — nobody drops off the follow-up list. But the Telegram
 * digest only announces whoever the view (`va.v_pulse_intro_pack_leads`,
 * `is_recent`) says crossed the 21-day mark within roughly the last week:
 * founder's call, 2026-09-28, after this cron's first run under the
 * pulse-views data path surfaced an 8-month-old backlog (24-242 days
 * unconverted) all at once, since none of them had a Notion lead row yet.
 * That backlog only existed because this was effectively this cron's
 * first real pass at that data — going forward, each person is only ever
 * a genuinely new Notion row once, so this mainly guards against a
 * repeat: a future multi-week data gap (asOf jumping forward all at once)
 * shouldn't flood the digest with long-overdue names again.
 */

import { log } from "../lib/log.js";
import { describePostExpiryVisit, findUnconvertedIntroPacks } from "../lib/intro-pack-conversion.js";
import { isStudioDbAvailable } from "../lib/studio-db.js";
import { sendGroupMessageWithSource } from "../lib/pulse-source.js";
import { memberIdFromEmail } from "../lib/pulse-views.js";
import { formatLeadsDigest, type NewLeadSummary } from "../messages/leads.js";
import * as notion from "../notion.js";
import type { IntroTrackingEstado } from "../types.js";

/** Estados on "Tracking intro packs" that keep someone out of Leads a contactar. */
const SKIP_AS_LEAD: IntroTrackingEstado[] = ["Perdido", "Convertido", "Comprou outra coisa"];

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
  let sourceView: Awaited<ReturnType<typeof findUnconvertedIntroPacks>>["sourceView"];
  try {
    ({ candidates, asOf, sourceView } = await findUnconvertedIntroPacks());
  } catch (err) {
    log.error("leads_intro_pack.fetch_failed", { message: errMsg(err) });
    return;
  }

  // Someone a founder closed on "Tracking intro packs" never becomes a lead
  // here: Perdido (founder, 2026-10-02), and Convertido / Comprou outra coisa
  // even when set by hand for a purchase Kenko doesn't show (2026-10-05). A
  // failed read stops the run rather than risk adding them; next Monday retries.
  let lostOnTracking = new Set<string>();
  if (process.env.NOTION_INTRO_TRACKING_DB_ID) {
    try {
      const rows = await notion.getAllIntroTrackingRows();
      lostOnTracking = new Set(
        rows.filter((r) => r.estado !== null && SKIP_AS_LEAD.includes(r.estado)).map((r) => r.memberId),
      );
    } catch (err) {
      log.error("leads_intro_pack.tracking_read_failed", { message: errMsg(err) });
      return;
    }
  }

  const created: NewLeadSummary[] = [];
  const digestWorthy: NewLeadSummary[] = [];
  let skippedExisting = 0;
  let skippedLost = 0;
  let backlogSuppressed = 0;

  for (const c of candidates) {
    if (lostOnTracking.has(memberIdFromEmail(c.email))) {
      skippedLost++;
      continue;
    }
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
      if (c.isRecent) {
        digestWorthy.push({ nome: c.name, canal: "Intro Pack" });
      } else {
        backlogSuppressed++;
      }
    } catch (err) {
      log.error("leads_intro_pack.write_failed", { email: c.email, message: errMsg(err) });
    }
  }

  const message = formatLeadsDigest(digestWorthy);
  if (!message) {
    log.info("leads_intro_pack.no_new", {
      totalCandidates: candidates.length,
      skippedExisting,
      skippedLost,
      created: created.length,
      backlogSuppressed,
    });
    return;
  }
  try {
    const messageId = await sendGroupMessageWithSource(message, [sourceView], asOf);
    log.info("leads_intro_pack.posted", {
      messageId,
      count: digestWorthy.length,
      created: created.length,
      backlogSuppressed,
      skippedExisting,
      skippedLost,
    });
  } catch (err) {
    log.error("leads_intro_pack.send_failed", { message: errMsg(err) });
  }
}
