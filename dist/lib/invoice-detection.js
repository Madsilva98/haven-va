/**
 * Keyword pre-filter for the tidy-mailboxes invoice forward: decides
 * whether an email is worth asking the Haiku gate (classify-invoice.ts)
 * "is this a supplier bill?". Deliberately cheap and conservative — it
 * only narrows the field, the LLM makes the actual call.
 *
 * Tightened 2026-09-28 after a "Proposta de orçamento" (a cleaning
 * supplier's quote, not an invoice) was forwarded to faturas@ repeatedly.
 * The old check matched plain substrings anywhere in the first 1,000 chars
 * of the body — quoted thread history, "faturação", "recibos verdes" all
 * counted. Now:
 *  - only the attachment filenames and the subject are looked at, never
 *    the body (quoted history was the main false-positive source);
 *  - whole words only — "fatura" matches in "fatura_setembro.pdf" (`_` and
 *    `-` are separators) but not inside "faturação";
 *  - quotes/proposals/contracts are vetoed unless an attachment filename
 *    itself says it's an invoice.
 * See docs/knowledge-base/tidy-mailboxes-feedback-log.md (2026-09-28).
 */
const INVOICE_WORDS = [
    "fatura",
    "faturas",
    "factura",
    "facturas",
    "fatura-recibo",
    "invoice",
    "invoices",
    "recibo",
    "recibos",
    "receipt",
    "receipts",
];
// Things that come with a PDF and talk about money but aren't a bill to pay.
const NOT_INVOICE_WORDS = [
    "orçamento",
    "orçamentos",
    "orcamento",
    "orcamentos",
    "proposta",
    "propostas",
    "proposal",
    "quote",
    "quotation",
    "cotação",
    "cotacao",
    "contrato",
    "contratos",
    "contract",
    "acordo",
    "agreement",
];
// Letter-bounded, not \b — \b treats "_" as a word character (so it would
// miss "fatura_setembro.pdf") and doesn't know "ç"/"ã" are letters (so it
// would match "fatura" inside "faturação").
function containsWord(text, words) {
    const lower = text.toLowerCase();
    return words.some((w) => {
        const escaped = w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        return new RegExp(`(?<!\\p{L})${escaped}(?!\\p{L})`, "u").test(lower);
    });
}
export function mentionsInvoice(text) {
    return containsWord(text, INVOICE_WORDS);
}
export function mentionsNonInvoiceDocument(text) {
    return containsWord(text, NOT_INVOICE_WORDS);
}
function isPdfOrImage(contentType) {
    return /^application\/pdf$/i.test(contentType) || /^image\//i.test(contentType);
}
/**
 * Returns the PDF/image attachments that make this worth an invoice check,
 * or null. Needs a PDF/image attachment AND an invoice word in an
 * attachment filename or the subject; a quote/proposal/contract word in the
 * subject or a filename vetoes it unless a filename itself names an invoice.
 */
export function invoiceCandidateAttachments(subject, attachments) {
    const candidates = attachments.filter((a) => isPdfOrImage(a.contentType));
    if (candidates.length === 0)
        return null;
    const nameSaysInvoice = candidates.some((a) => mentionsInvoice(a.name));
    if (!nameSaysInvoice && !mentionsInvoice(subject))
        return null;
    const saysOtherDocument = mentionsNonInvoiceDocument(subject) || candidates.some((a) => mentionsNonInvoiceDocument(a.name));
    if (saysOtherDocument && !nameSaysInvoice)
        return null;
    return candidates;
}
