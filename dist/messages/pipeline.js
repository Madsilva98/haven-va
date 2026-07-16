/**
 * Phase 3 — pipeline alert formatters.
 *
 * All output is pt-PT, "tu", lowercase preferred, terse.
 * Used by the cron pipeline-alerts handler before sending DMs to owners.
 */
function statusOrDash(s) {
    return s && s.trim().length > 0 ? s.toLowerCase() : "—";
}
function quoteDraft(draft) {
    // Telegram-friendly blockquote-ish formatting using "> " line prefix.
    const trimmed = draft.trim();
    if (trimmed.length === 0)
        return "";
    return trimmed
        .split(/\r?\n/)
        .map((line) => `> ${line}`)
        .join("\n");
}
export function formatPartnerAlert(row, daysSinceContact, suggestedFollowup) {
    const lines = [];
    lines.push(`🤝 parceria parada: ${row.nome}`);
    lines.push(`status: ${statusOrDash(row.status)} · ${daysSinceContact}d sem contacto`);
    if (row.proximoPasso && row.proximoPasso.trim().length > 0) {
        lines.push(`próximo passo: ${row.proximoPasso}`);
    }
    lines.push("");
    lines.push("sugestão de follow-up:");
    lines.push(quoteDraft(suggestedFollowup));
    return lines.join("\n");
}
export function formatInfluencerAlert(row, daysSinceContact, suggestedFollowup) {
    const lines = [];
    const handle = row.instagram ? ` (${row.instagram})` : "";
    lines.push(`📸 influencer parada: ${row.nome}${handle}`);
    lines.push(`status: ${statusOrDash(row.status)} · ${daysSinceContact}d sem contacto`);
    if (row.proximoPasso && row.proximoPasso.trim().length > 0) {
        lines.push(`próximo passo: ${row.proximoPasso}`);
    }
    lines.push("");
    lines.push("sugestão de follow-up:");
    lines.push(quoteDraft(suggestedFollowup));
    return lines.join("\n");
}
export function formatContentAlert(rows) {
    const lines = ["📅 conteúdo por agendar (próx. 2 dias):"];
    for (const row of rows) {
        const date = row.date.slice(0, 10);
        const channel = row.channel ? ` [${row.channel}]` : "";
        lines.push(`• ${row.title} — ${date}${channel} (${row.status})`);
    }
    return lines.join("\n");
}
export function formatReminderMessage(r) {
    const lines = [`⏰ ${r.texto}`];
    if (r.origem && r.origem.trim().length > 0) {
        // single-line context
        const ctx = r.origem.replace(/\s+/g, " ").trim();
        lines.push(`(do que disseste: "${ctx}")`);
    }
    return lines.join("\n");
}
