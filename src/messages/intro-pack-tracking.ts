/**
 * Daily Telegram note for the "Tracking intro packs" list: who joined the
 * list on this run, who already on it gained a new reason (founder,
 * 2026-10-03: "go on telegram"), and who converted to a membership. Null =
 * nothing new, no message.
 */

import type { NewMotivo, TrackingCreate } from "../lib/intro-pack-tracking.js";

function aulas(n: number): string {
  return n === 1 ? "1 aula" : `${n} aulas`;
}

export function formatIntroTrackingDigest(
  created: TrackingCreate[],
  converted: string[],
  newMotivos: NewMotivo[] = [],
): string | null {
  if (created.length === 0 && converted.length === 0 && newMotivos.length === 0) return null;
  const lines: string[] = [];

  if (created.length > 0) {
    lines.push("📦 *Intro packs — novos na lista:*");
    for (const c of created) {
      const f = c.fields;
      lines.push(
        `• ${c.name} — ${f.motivos.join(" + ")}, ${f.pack}, ${aulas(f.aulasFeitas)} feita(s)` +
          (f.aulasMarcadas > 0 ? `, ${aulas(f.aulasMarcadas)} marcada(s)` : "") +
          (f.telefone ? ` (${f.telefone})` : ""),
      );
    }
  }

  if (newMotivos.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push("🔁 *Já na lista — novo motivo:*");
    for (const n of newMotivos) lines.push(`• ${n.name} — ${n.motivos.join(" + ")}`);
  }

  if (converted.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push("🎉 *Converteram para mensalidade:*");
    for (const name of converted) lines.push(`• ${name}`);
  }

  return lines.join("\n");
}
