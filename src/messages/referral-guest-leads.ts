/**
 * Daily Telegram note for "Referidos e convidados": only who joined the list today, to push them
 * to buy an intro pack (Madalena, 2026-10-16). Plain text. Null = nobody new, no message.
 */

import type { ReferralGuestCreate } from "../lib/referral-guest-leads.js";

const MAX_LINES = 10;

export function formatReferralGuestDigest(created: ReferralGuestCreate[]): string | null {
  const fresh = created.filter((c) => c.estado === "A contactar");
  if (fresh.length === 0) return null;
  const lines = fresh
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name, "pt"))
    .slice(0, MAX_LINES)
    .map((c) => {
      const via = c.fields.trazidaPor ? ` via ${c.fields.trazidaPor}` : "";
      return `· ${c.name}: ${c.fields.origem}${via}${c.fields.telefone ? ` · ${c.fields.telefone}` : ""}`;
    });
  const more = fresh.length > MAX_LINES ? [`+${fresh.length - MAX_LINES} na lista do Notion`] : [];
  return ["Referidos e convidados · novos na lista (ainda sem intro pack)", ...lines, ...more].join("\n");
}
