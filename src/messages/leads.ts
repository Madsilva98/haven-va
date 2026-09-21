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
// plausibly produce dozens+ of new leads at once — the other two leads
// crons stay on the unchunked formatLeadsDigest above, unaffected.
const MAX_CHUNK_CHARS = 3500;

export function formatLeadsDigests(newLeads: NewLeadSummary[]): string[] {
  if (newLeads.length === 0) return [];

  const itemLines = newLeads.map((lead) => `• ${lead.nome} (${lead.canal})`);
  const chunks: string[][] = [[]];
  let currentLength = 0;
  for (const line of itemLines) {
    const currentChunk = chunks[chunks.length - 1]!;
    if (currentLength + line.length + 1 > MAX_CHUNK_CHARS && currentChunk.length > 0) {
      chunks.push([]);
      currentLength = 0;
    }
    chunks[chunks.length - 1]!.push(line);
    currentLength += line.length + 1;
  }

  return chunks.map((lines, i) => {
    const header =
      chunks.length > 1
        ? `📬 *${newLeads.length} novo(s) lead(s) a contactar (parte ${i + 1}/${chunks.length}):*`
        : `📬 *${newLeads.length} novo(s) lead(s) a contactar:*`;
    return [header, ...lines].join("\n");
  });
}
