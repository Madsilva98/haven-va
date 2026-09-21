/**
 * Claude Haiku extractor for the competitor-intel pipeline: reads a
 * competitor/inspiration newsletter email and pulls out 0+ concrete
 * findings (events, promotions, positioning/message changes, product or
 * service launches).
 *
 * Throws on any API/parse failure rather than swallowing it — the caller
 * (the shared processing pipeline) treats that as "not yet processed" and
 * leaves the "processado" label off, so the message is retried on the next
 * run instead of silently being treated as "genuinely nothing found".
 * An empty array is a real, successful zero-findings result.
 */
import Anthropic from "@anthropic-ai/sdk";
import { log } from "./log.js";
const MODEL = "claude-haiku-4-5";
const MAX_BODY_CHARS = 8000;
const KNOWN_TIPOS = [
    "Evento",
    "Promoção/Campanha",
    "Posicionamento/Mensagem",
    "Produto/Serviço",
];
const SYSTEM_INSTRUCTION = "Analisas newsletters de concorrentes e de negócios de inspiração para um estúdio de Pilates (The Haven), " +
    "para extrair achados concretos e úteis: eventos, promoções/campanhas, mudanças de posicionamento/mensagem, " +
    "lançamentos ou alterações de produtos/serviços. " +
    `As categorias conhecidas são: ${KNOWN_TIPOS.join(", ")}. ` +
    "Se um achado não encaixar bem em nenhuma, podes propor uma categoria nova curta em pt-PT em vez de forçar uma das existentes — o founder revê e limpa depois. " +
    "Ignora ruído sem valor competitivo: rodapés, disclaimers legais, links de unsubscribe, saudações genéricas sem novidade nenhuma. " +
    "Um email pode conter zero, um, ou vários achados distintos — extrai cada achado separadamente, não os agregues num só. " +
    "Se o email não tiver nada de relevante, devolve uma lista vazia. " +
    'Responde APENAS com um array JSON válido, nada antes nem depois, nesta forma exata: ' +
    '[{"tipo": "Categoria", "resumo": "1-3 frases em pt-PT descrevendo o achado"}]';
let client = null;
function getClient() {
    if (client)
        return client;
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) {
        log.warn("extract_competitor_intel.no_api_key");
        return null;
    }
    client = new Anthropic({ apiKey: key });
    return client;
}
function buildUserPrompt(params) {
    const body = params.body.slice(0, MAX_BODY_CHARS);
    return [
        `De: ${params.fromName} <${params.fromEmail}>`,
        `Assunto: ${params.subject}`,
        "",
        body,
    ].join("\n");
}
/** Pulls the first top-level JSON array out of a response that may have stray prose around it. */
function extractJsonArray(text) {
    const start = text.indexOf("[");
    const end = text.lastIndexOf("]");
    if (start === -1 || end === -1 || end < start)
        return null;
    try {
        return JSON.parse(text.slice(start, end + 1));
    }
    catch {
        return null;
    }
}
export async function extractCompetitorIntel(params) {
    const c = getClient();
    if (!c)
        throw new Error("extract_competitor_intel: sem ANTHROPIC_API_KEY");
    const response = await c.messages.create({
        model: MODEL,
        max_tokens: 1024,
        system: [
            {
                type: "text",
                text: SYSTEM_INSTRUCTION,
                cache_control: { type: "ephemeral" },
            },
        ],
        messages: [{ role: "user", content: buildUserPrompt(params) }],
    });
    const text = response.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("")
        .trim();
    const parsed = extractJsonArray(text);
    if (!Array.isArray(parsed)) {
        log.warn("extract_competitor_intel.unparseable_response", { text: text.slice(0, 200) });
        throw new Error("extract_competitor_intel: resposta não é um array JSON");
    }
    const findings = [];
    for (const item of parsed) {
        if (item &&
            typeof item === "object" &&
            typeof item.tipo === "string" &&
            typeof item.resumo === "string") {
            findings.push({
                tipo: item.tipo.trim(),
                resumo: item.resumo.trim(),
            });
        }
    }
    return findings;
}
