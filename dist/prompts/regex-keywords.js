/**
 * Tier 0 free regex pre-filter.
 *
 * If `REGEX_KEYWORDS.test(text)` returns false, the message is dropped
 * before any Claude call. The keyword list is the verb/temporal
 * whitelist from spec § "Tier 0 — free regex". Case-insensitive,
 * supports pt-PT diacritics (ã, á, ç, …).
 *
 * The pattern is intentionally permissive — false negatives at this
 * stage are cheaper than false positives (we'd burn Haiku tokens on
 * pure noise). Tier 1 narrows the funnel further.
 */
export const MIN_LENGTH = 8;
export const REGEX_KEYWORDS = /(?:precis|temos de|tens que|tenho de|temos que|temos|vou|vamos|marcar|contactar|enviar|preparar|comprar|reservar|ligar|escrever|fazer|lembr|update|atualiz|follow.?up|muda|mudar|fechar|fechado|feito|done|amanhã|segunda|terça|quarta|quinta|sexta|próxima|esta semana|todo|tarefa|task)/iu;
