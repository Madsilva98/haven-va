/**
 * Weekly churn-risk scan. Three parts:
 *
 * 1. Sweeps away any row the founder has closed out (Status="Resolvido"
 *    or "Arquivado") — she sets that by hand in Notion, this is the "next
 *    time the cron runs, tidy it away" half of that workflow. Same "stay
 *    alive" behaviour the founder asked for on Leads a contactar
 *    (src/crons/leads-reconcile.ts).
 * 2. Computes the 3 validated signals (src/lib/churn-signals.ts) against
 *    Studio Supabase for every still-Active subscriber, creates/updates
 *    "Clientes em risco" rows to match exactly (not an additive union —
 *    a signal that's no longer true gets dropped from the row, not just
 *    new ones added), and posts one digest listing who's newly flagged,
 *    gained a signal, or lost one this week — found in production
 *    2026-09-21: without this, a row like "sem reservas 14+ dias" stayed
 *    stuck showing that even after the person booked again.
 * 3. Reconciles every OTHER still-open row (i.e. not touched by #2 because
 *    Studio Supabase no longer flags that email at all this week) — the
 *    founder's call (2026-09-21): once a row shows zero current signals
 *    there's nothing left to watch, archive it like any other closed-out
 *    row, whether that's because the person cancelled/deactivated
 *    (subscription no longer Active — also found in production 2026-09-21,
 *    a churned customer's row was sitting open indefinitely since nothing
 *    ever re-checked it once their subscription dropped out of the
 *    "Active" filter in churn-signals.ts) or because they're still active
 *    but resolved every signal (e.g. booked again). A row that resolved
 *    SOME signals but still has at least one open one is handled by #2
 *    instead — it stays open and in the digest, since that's still worth
 *    watching or contacting about.
 *
 * No-ops silently if STUDIO_SUPABASE_URL/KEY aren't configured, same as
 * the birthday cron.
 */

import { fetchChurnFlags } from "../lib/churn-signals.js";
import { log } from "../lib/log.js";
import { isStudioSupabaseAvailable } from "../lib/studio-supabase.js";
import { sendGroupMessage } from "../lib/telegram.js";
import { formatChurnDigest, type ChurnDigestEntry } from "../messages/churn.js";
import * as notion from "../notion.js";

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function run(): Promise<void> {
  if (!process.env.NOTION_CHURN_RISK_DB_ID) {
    log.debug("churn_risk.skipped", { reason: "NOTION_CHURN_RISK_DB_ID not set" });
    return;
  }
  if (!isStudioSupabaseAvailable()) {
    log.debug("churn_risk.skipped", { reason: "studio_supabase_not_configured" });
    return;
  }

  let archivedClosed = 0;
  try {
    const closed = await notion.getChurnRowsByStatus(["Resolvido", "Arquivado"]);
    for (const row of closed) {
      try {
        await notion.archivePage(row.id);
        archivedClosed++;
      } catch (err) {
        log.error("churn_risk.archive_closed_failed", { pageId: row.id, message: errMsg(err) });
      }
    }
  } catch (err) {
    log.error("churn_risk.fetch_closed_failed", { message: errMsg(err) });
  }

  let flags: Awaited<ReturnType<typeof fetchChurnFlags>>["flags"];
  let activeEmails: Set<string>;
  try {
    ({ flags, activeEmails } = await fetchChurnFlags());
  } catch (err) {
    log.error("churn_risk.fetch_failed", { message: errMsg(err) });
    return;
  }

  const changed: ChurnDigestEntry[] = [];
  const flaggedEmails = new Set(flags.map((f) => f.email.toLowerCase().trim()));

  for (const flag of flags) {
    const signalTypes = flag.signals.map((s) => s.type);
    const detalhes = flag.signals.map((s) => s.detail).join("; ");
    try {
      const existing = await notion.getChurnRowByEmail(flag.email);
      if (!existing) {
        await notion.createChurnFlag(flag.name, flag.email, signalTypes, detalhes, flag.plano, flag.telefone);
        changed.push({ nome: flag.name, sinais: signalTypes });
        continue;
      }
      const added = signalTypes.filter((t) => !existing.sinais.includes(t));
      const resolved = existing.sinais.filter((t) => !signalTypes.includes(t));
      if (added.length === 0 && resolved.length === 0) continue; // nothing changed since last week
      // Sync to exactly this week's signals — not a union — so a signal
      // the person has since resolved (e.g. booked again) actually drops
      // off the row instead of sticking around forever.
      await notion.updateChurnFlag(existing.id, signalTypes, detalhes);
      changed.push({ nome: flag.name, sinais: [...added, ...resolved.map((t) => `${t} (resolvido)`)] });
    } catch (err) {
      log.error("churn_risk.write_failed", { email: flag.email, message: errMsg(err) });
    }
  }

  // Reconcile every other still-open row: not touched above because
  // Studio Supabase doesn't flag that email at all this week — zero
  // current signals either way, so archive it (silently, like the
  // Resolvido/Arquivado sweep above — not something to nag the founder
  // about in the digest).
  let archivedResolved = 0;
  let archivedChurned = 0;
  try {
    const open = await notion.getChurnRowsByStatus(["Aberto", "Contactado"]);
    for (const row of open) {
      if (!row.email) continue;
      const email = row.email.toLowerCase().trim();
      if (flaggedEmails.has(email)) continue; // already handled above

      try {
        await notion.archivePage(row.id);
        if (activeEmails.has(email)) {
          archivedResolved++; // still active, just resolved every signal
        } else {
          archivedChurned++; // no longer an active subscriber at all
        }
      } catch (err) {
        log.error("churn_risk.reconcile_open_failed", { pageId: row.id, message: errMsg(err) });
      }
    }
  } catch (err) {
    log.error("churn_risk.fetch_open_failed", { message: errMsg(err) });
  }

  const message = formatChurnDigest(changed);
  if (!message) {
    log.info("churn_risk.no_changes", { totalFlagged: flags.length, archivedClosed, archivedResolved, archivedChurned });
    return;
  }
  try {
    const messageId = await sendGroupMessage(message);
    log.info("churn_risk.posted", {
      messageId,
      count: changed.length,
      archivedClosed,
      archivedResolved,
      archivedChurned,
    });
  } catch (err) {
    log.error("churn_risk.send_failed", { message: errMsg(err) });
  }
}
