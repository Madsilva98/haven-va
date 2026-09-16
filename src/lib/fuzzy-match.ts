/**
 * Pure fuzzy string matching, shared by Notion title/page matching
 * (src/notion.ts) and Supabase name matching (src/lib/leads.ts). No
 * dependency on either — safe to use against any two free-text strings.
 */

const PT_STOPWORDS = new Set([
  "o", "a", "os", "as", "um", "uma", "de", "do", "da", "dos", "das",
  "e", "em", "no", "na", "nos", "nas", "para", "já", "com", "por",
  "ao", "à", "que", "se", "não", "mas", "ou", "ao", "às",
]);

export function normalizeText(s: string): string {
  return s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
}

export function scoreMatch(title: string, query: string): number {
  const t = normalizeText(title);
  const q = normalizeText(query);
  if (t === q) return 1;
  if (t.includes(q) || q.includes(t)) return 0.8;
  const tWords = new Set(t.split(/\s+/).filter((w) => w.length > 2));
  const qWords = q.split(/\s+/).filter((w) => w.length > 2);
  if (qWords.length === 0 || tWords.size === 0) return 0;
  const overlap = qWords.filter(
    (w) => tWords.has(w) || [...tWords].some((tw) => tw.includes(w) || w.includes(tw)),
  ).length;
  return overlap > 0 ? overlap / Math.max(qWords.length, tWords.size) : 0;
}

export function significantWords(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .map((w) => w.replace(/[^\wàáâãéêíóôõúüç]/gi, ""))
    .filter((w) => w.length > 2 && !PT_STOPWORDS.has(w));
}
