/**
 * Weekly "Leads a contactar" digest — used by both src/crons/leads-email-scan.ts
 * and src/crons/leads-intro-pack.ts. Returns null (silent, no message sent)
 * when nothing new was added, same contract as formatBirthdayDigest.
 */

export interface NewLeadSummary {
  nome: string;
  canal: string;
}

export function formatLeadsDigest(newLeads: NewLeadSummary[]): string | null {
  if (newLeads.length === 0) return null;

  const lines: string[] = [`📬 *${newLeads.length} novo(s) lead(s) a contactar:*`];
  for (const lead of newLeads) {
    lines.push(`• ${lead.nome} (${lead.canal})`);
  }
  return lines.join("\n");
}

// Telegram messages cap out around 4096 chars — a single unchunked digest
// of a big batch (e.g. src/crons/leads-instagram-scan.ts's first,
// historical-backlog run) could silently fail to send. Chunks into
// multiple messages instead of skipping the digest, since a big batch is
// exactly the moment visibility matters most. Used only where a run could
// plausibly produce dozens+ of new items at once — the other two leads
// crons stay on the unchunked formatLeadsDigest above, unaffected.
const MAX_CHUNK_CHARS = 3500;

// Pure — splits `lines` into Telegram-safe chunks, prefixing each with
// `header(total, part, parts)`. Shared by formatLeadsDigests and
// formatPartnerCandidatesDigests below.
function chunkDigest(lines: string[], header: (total: number, part: number, parts: number) => string): string[] {
  if (lines.length === 0) return [];

  const chunks: string[][] = [[]];
  let currentLength = 0;
  for (const line of lines) {
    const currentChunk = chunks[chunks.length - 1]!;
    if (currentLength + line.length + 1 > MAX_CHUNK_CHARS && currentChunk.length > 0) {
      chunks.push([]);
      currentLength = 0;
    }
    chunks[chunks.length - 1]!.push(line);
    currentLength += line.length + 1;
  }

  return chunks.map((chunkLines, i) => [header(lines.length, i + 1, chunks.length), ...chunkLines].join("\n"));
}

export function formatLeadsDigests(newLeads: NewLeadSummary[]): string[] {
  const lines = newLeads.map((lead) => `• ${lead.nome} (${lead.canal})`);
  return chunkDigest(
    lines,
    (total, part, parts) =>
      parts > 1
        ? `📬 *${total} novo(s) lead(s) a contactar (parte ${part}/${parts}):*`
        : `📬 *${total} novo(s) lead(s) a contactar:*`,
  );
}

/**
 * Separate from formatLeadsDigests on purpose — these are potential
 * partners noticed via Instagram DM (src/crons/leads-instagram-scan.ts),
 * not leads to contact, so they get their own digest wording and land in
 * a different Notion DB (Partner Pipeline, not Leads a contactar).
 */
export interface NewPartnerSummary {
  nome: string;
}

export function formatPartnerCandidatesDigests(newPartners: NewPartnerSummary[]): string[] {
  const lines = newPartners.map((p) => `• ${p.nome}`);
  return chunkDigest(
    lines,
    (total, part, parts) =>
      parts > 1
        ? `🤝 *${total} potencial(is) parceiro(s) via Instagram (parte ${part}/${parts}):*`
        : `🤝 *${total} potencial(is) parceiro(s) via Instagram:*`,
  );
}

/**
 * Separate from formatPartnerCandidatesDigests on purpose — content
 * creators offering a class-for-post trade land in "Influencer Pipeline",
 * not "Partner Pipeline" (founder's call, 2026-09-21).
 */
export interface NewInfluencerSummary {
  nome: string;
}

export function formatInfluencerCandidatesDigests(newInfluencers: NewInfluencerSummary[]): string[] {
  const lines = newInfluencers.map((p) => `• ${p.nome}`);
  return chunkDigest(
    lines,
    (total, part, parts) =>
      parts > 1
        ? `📸 *${total} potencial(is) influencer(s) via Instagram (parte ${part}/${parts}):*`
        : `📸 *${total} potencial(is) influencer(s) via Instagram:*`,
  );
}

/**
 * Instagram contacts whose name fuzzy-matched an existing Partner/
 * Influencer Pipeline row closely enough that leads-instagram-scan.ts
 * skipped creating a page rather than risk a silent duplicate (e.g.
 * "Wanderlust" already existing from the Outlook partnerships sync, then
 * "Wanderlust_Portugal" showing up via Instagram a week later — found in
 * production 2026-09-21, no dedup existed at all before this). Never
 * auto-merged — a human decides whether it's really the same contact.
 */
export interface DuplicateCandidateSummary {
  nome: string;
  existente: string;
  pipeline: "Partner Pipeline" | "Influencer Pipeline";
}

export function formatDuplicateCandidatesDigests(duplicates: DuplicateCandidateSummary[]): string[] {
  const lines = duplicates.map((d) => `• ${d.nome} — parece igual a "${d.existente}" (${d.pipeline})`);
  return chunkDigest(
    lines,
    (total, part, parts) =>
      parts > 1
        ? `🔁 *${total} possível(eis) duplicado(s) via Instagram — não criados, rever manualmente (parte ${part}/${parts}):*`
        : `🔁 *${total} possível(eis) duplicado(s) via Instagram — não criados, rever manualmente:*`,
  );
}
