/**
 * Daily digest of still-active intro packs worth a same-day nudge, grouped
 * by the two usage patterns `va.v_pulse_intro_pack_watch` already filtered
 * for. Returns null (no message sent) when nobody matches, same contract
 * as the other digests.
 *
 * No single top-level "next N days" claim — the two pack types now have
 * different windows (2-Class: this calendar week; 10-Day: 3 real days,
 * see the view for why), so each section states its own window instead of
 * a header that would be wrong for one of them (found 2026-09-30, right
 * after the 2-Class window changed from a flat 3 days to "this week").
 */

import type { ExpiringIntroPackToWatch } from "../lib/intro-pack-conversion.js";

function formatDate(d: Date): string {
  return d.toLocaleDateString("pt-PT", { timeZone: "Europe/Lisbon" });
}

export function formatExpiringIntroPacksDigest(packs: ExpiringIntroPackToWatch[]): string | null {
  if (packs.length === 0) return null;

  const twoClasses = packs.filter((p) => p.pack === "2-Class");
  const tenDay = packs.filter((p) => p.pack === "10-Day");

  const lines: string[] = ["📦 *Intro packs a terminar em breve:*"];

  if (twoClasses.length > 0) {
    lines.push("", "2 Classes — só usaram 1 aula, a terminar esta semana:");
    for (const p of twoClasses) {
      lines.push(`• ${p.name} — termina ${formatDate(p.expiresAt)}${p.phone ? ` (${p.phone})` : ""}`);
    }
  }

  if (tenDay.length > 0) {
    lines.push("", "10-Day Unlimited — já fizeram mais de 5 aulas, a terminar nos próximos 3 dias:");
    for (const p of tenDay) {
      lines.push(
        `• ${p.name} — termina ${formatDate(p.expiresAt)}, ${p.visitCount} aulas do pack${p.phone ? ` (${p.phone})` : ""}`,
      );
    }
  }

  return lines.join("\n");
}
