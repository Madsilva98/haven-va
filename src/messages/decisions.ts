/**
 * Proposal message formatters for to-discuss.
 */

import type { ToDiscussUrgency } from "../types.js";

interface FormattedMessage {
  text: string;
  parseMode: "HTML";
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * "vou adicionar ao To Discuss: «{tema}» — urgência: {urgencia}. confirmas?"
 */
export function formatToDiscussProposal(
  text: string,
  urgencia: ToDiscussUrgency,
): FormattedMessage {
  const safeTema = escapeHtml(text);
  const safeUrg = escapeHtml(urgencia.toLowerCase());
  const body =
    `vou adicionar ao To Discuss:\n\n` +
    `«${safeTema}»\n\n` +
    `urgência: ${safeUrg}\n\n` +
    `confirmas?`;
  return { text: body, parseMode: "HTML" };
}
