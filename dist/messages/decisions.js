/**
 * Phase 5 — Proposal message formatters for decisions / to-discuss / launch.
 *
 * Same conventions as `messages/proposal.ts`: pt-PT, "tu", terse, HTML
 * parse-mode. The caller attaches the inline keyboard separately.
 */
function escapeHtml(value) {
    return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
const AREA_LABEL_PT = {
    Marketing: "marketing",
    Operações: "operações",
    Parcerias: "parcerias",
    Influencers: "influencers",
    Tech: "tech",
    Cliente: "cliente",
    Financeiro: "financeiro",
    Outro: "outro",
};
const TEMPLATE_LABEL_PT = {
    "programa-novo": "programa novo",
    parceria: "parceria",
    evento: "evento",
    influencer: "influencer",
};
/**
 * "foi tomada uma decisão? «{decisao}» — área {area}, por {tomadaPor}. registo?"
 */
export function formatDecisionProposal(extraction) {
    const decisao = escapeHtml(extraction.decisao);
    const area = escapeHtml(AREA_LABEL_PT[extraction.area] ?? extraction.area.toLowerCase());
    const por = extraction.tomadaPor.map((n) => escapeHtml(n)).join(", ");
    const text = `foi tomada uma decisão?\n\n` +
        `«${decisao}»\n\n` +
        `área: ${area}\n` +
        `por: ${por}\n\n` +
        `registo?`;
    return { text, parseMode: "HTML" };
}
/**
 * "vou adicionar ao To Discuss: «{tema}» — urgência: {urgencia}. confirmas?"
 */
export function formatToDiscussProposal(text, urgencia) {
    const safeTema = escapeHtml(text);
    const safeUrg = escapeHtml(urgencia.toLowerCase());
    const body = `vou adicionar ao To Discuss:\n\n` +
        `«${safeTema}»\n\n` +
        `urgência: ${safeUrg}\n\n` +
        `confirmas?`;
    return { text: body, parseMode: "HTML" };
}
/**
 * "vais lançar '{name}' a {launchDate}? proponho {N} tasks com base no template '{templateId}':
 * - task 1
 * - task 2
 * - task 3
 *
 * + {N-3} mais"
 */
export function formatLaunchProposal(extraction, taskCount, taskTitles) {
    const name = escapeHtml(extraction.name);
    const date = escapeHtml(extraction.launchDate);
    const tplLabel = escapeHtml(TEMPLATE_LABEL_PT[extraction.templateId] ?? extraction.templateId);
    const preview = taskTitles.slice(0, 3).map((t) => `- ${escapeHtml(t)}`);
    const more = taskCount - preview.length;
    const lines = [];
    lines.push(`vais lançar '${name}' a ${date}?`);
    lines.push("");
    lines.push(`proponho ${taskCount} tasks com base no template '${tplLabel}':`);
    lines.push("");
    lines.push(...preview);
    if (more > 0) {
        lines.push("");
        lines.push(`+ ${more} mais`);
    }
    return { text: lines.join("\n"), parseMode: "HTML" };
}
