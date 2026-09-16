/**
 * Weekly "Leads a contactar" digest — used by both src/crons/leads-email-scan.ts
 * and src/crons/leads-intro-pack.ts. Returns null (silent, no message sent)
 * when nothing new was added, same contract as formatBirthdayDigest.
 */
export function formatLeadsDigest(newLeads) {
    if (newLeads.length === 0)
        return null;
    const lines = [`📬 *${newLeads.length} novo(s) lead(s) a contactar:*`];
    for (const lead of newLeads) {
        lines.push(`• ${lead.nome} (${lead.canal})`);
    }
    return lines.join("\n");
}
