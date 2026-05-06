/**
 * Proposal message formatters for to-discuss.
 */
function escapeHtml(value) {
    return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
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
