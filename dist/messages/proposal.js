/**
 * Builders for the bot's proposal messages (NEW_TASK and EDIT_TASK).
 * Returns Telegram-ready text in HTML parse mode. The caller is
 * responsible for attaching the inline-keyboard buttons.
 */
/**
 * Escapes characters that have meaning in Telegram HTML parse mode.
 * Per Telegram Bot API, only <, >, and & must be escaped in text content.
 */
function escapeHtml(value) {
    return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
/**
 * Renders the owner as a Telegram mention. If a numeric Telegram id is
 * provided, builds a clickable mention (`tg://user?id=...`) so the user
 * is pinged. Otherwise falls back to a plain `@handle`-style label.
 */
function renderOwnerMention(owner, ownerTelegramId) {
    if (owner === "Unassigned") {
        return "@unassigned";
    }
    const display = escapeHtml(owner);
    if (ownerTelegramId !== null) {
        return `<a href="tg://user?id=${ownerTelegramId}">${display}</a>`;
    }
    return `@${owner.toLowerCase()}`;
}
/**
 * Owner phrasing in pt-PT: "@madalena" / "@beatriz" → "para a ...",
 * "@mafalda" → "para a ...", "@unassigned" → "para o backlog".
 * The bot uses "para a/o X" depending on the noun.
 */
function ownerPreposition(owner) {
    if (owner === "Unassigned")
        return "para";
    // All three founders are female — pt-PT uses "para a".
    return "para a";
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
/**
 * Builds the NEW_TASK proposal message body. The caller adds the
 * `[🔴 alta] [🟡 média] [🟢 baixa] [❌ ignorar]` keyboard separately.
 */
export function formatNewTaskProposal(extraction, ownerTelegramId) {
    const ownerMention = renderOwnerMention(extraction.owner, ownerTelegramId);
    const prep = ownerPreposition(extraction.owner);
    const title = escapeHtml(extraction.title);
    const area = escapeHtml(AREA_LABEL_PT[extraction.area] ?? extraction.area.toLowerCase());
    const text = `Vou criar uma task ${prep} ${ownerMention}:\n\n` +
        `«${title}»\n\n` +
        `área: ${area}\n\n` +
        `Concordas? Qual a prioridade?`;
    return { text, parseMode: "HTML" };
}
const FIELD_LABEL_PT = {
    status: "status",
    owner: "owner",
    deadline: "deadline",
    prioridade: "prioridade",
    area: "área",
    title: "título",
};
/**
 * Builds the EDIT_TASK proposal message body. The caller adds the
 * `[✅ atualiza] [❌ deixa como está]` keyboard separately.
 */
export function formatEditProposal(extraction) {
    const title = escapeHtml(extraction.targetTitle);
    const fieldLabel = FIELD_LABEL_PT[extraction.field];
    const oldValue = escapeHtml(extraction.oldValue);
    const newValue = escapeHtml(extraction.newValue);
    const text = `Quero atualizar a task «${title}»:\n\n` +
        `${fieldLabel}: ${oldValue} → ${newValue}\n\n` +
        `Confirmas?`;
    return { text, parseMode: "HTML" };
}
