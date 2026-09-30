/**
 * The ONE Claude Haiku call the mail-triage cron makes per email
 * (src/crons/mail-triage.ts, prompt src/prompts/mail-triage.md). It
 * replaces three separate calls the old pair of crons made —
 * classify-mailbox-thread (still needs a reply?), classify-invoice
 * (supplier bill?) and lead-classifier's partnershipEmailIntent
 * (partner / influencer / supplier?) — so a partner email in geral@ is no
 * longer paid for twice (founder's call, 2026-09-30).
 *
 * Returns null when the model's answer can't be trusted (API error, not
 * JSON, missing fields). The caller treats null as "undecided": nothing is
 * recorded, forwarded or archived for that email and it's retried next
 * run — the safe side for every one of the three decisions.
 */
import Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "node:fs";
import { log } from "./log.js";
const MODEL = process.env.MAIL_TRIAGE_MODEL ?? "claude-haiku-4-5";
const MAX_BODY_CHARS = 6000;
const MAX_REPLY_CHARS = 3000;
const TIPOS = {
    PARCEIRO: "parceiro",
    INFLUENCER: "influencer",
    FORNECEDOR: "fornecedor",
    CANDIDATURA: "candidatura",
    CLIENTE: "cliente",
    OUTRO: "outro",
};
let client = null;
let prompt = null;
function runtime() {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) {
        log.warn("mail_verdict.no_api_key");
        return null;
    }
    client ??= new Anthropic({ apiKey: key });
    prompt ??= readFileSync(new URL("../prompts/mail-triage.md", import.meta.url), "utf8");
    return { client, prompt };
}
export function buildVerdictPrompt(input) {
    const lines = [
        `Caixa: ${input.mailbox}`,
        `De: ${input.fromName} <${input.fromEmail}>`,
        `Para: ${input.to.join(", ") || "(sem destinatários)"}`,
        `Assunto: ${input.subject}`,
        `Anexos: ${input.attachmentNames.length > 0 ? input.attachmentNames.join(", ") : "(nenhum)"}`,
        "",
        "Mensagem:",
        input.body.slice(0, MAX_BODY_CHARS),
    ];
    if (input.laterReplyBody) {
        lines.push("", "Resposta mais recente da equipa do Haven nesta conversa (enviada depois da mensagem acima):", input.laterReplyBody.slice(0, MAX_REPLY_CHARS));
    }
    return lines.join("\n");
}
/** Strict: any missing/wrong field means the answer isn't used at all. */
export function parseVerdict(text) {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match)
        return null;
    let raw;
    try {
        raw = JSON.parse(match[0]);
    }
    catch {
        return null;
    }
    if (!raw || typeof raw !== "object")
        return null;
    const r = raw;
    const tipo = typeof r.tipo === "string" ? TIPOS[r.tipo.trim().toUpperCase()] : undefined;
    if (!tipo)
        return null;
    if (typeof r.fatura_fornecedor !== "boolean" || typeof r.precisa_acao !== "boolean")
        return null;
    return {
        tipo,
        isSupplierInvoice: r.fatura_fornecedor,
        needsAction: r.precisa_acao,
        reason: typeof r.razao === "string" && r.razao.trim() ? r.razao.trim() : "(sem razão)",
    };
}
export async function classifyMail(input) {
    const rt = runtime();
    if (!rt)
        return null;
    try {
        const response = await rt.client.messages.create({
            model: MODEL,
            max_tokens: 250,
            system: [{ type: "text", text: rt.prompt, cache_control: { type: "ephemeral" } }],
            messages: [{ role: "user", content: buildVerdictPrompt(input) }],
        });
        const text = response.content
            .filter((b) => b.type === "text")
            .map((b) => b.text)
            .join("")
            .trim();
        const verdict = parseVerdict(text);
        if (!verdict)
            log.warn("mail_verdict.unparseable_response", { text: text.slice(0, 200) });
        return verdict;
    }
    catch (err) {
        log.warn("mail_verdict.failed", { message: err instanceof Error ? err.message : String(err) });
        return null;
    }
}
