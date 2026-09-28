/**
 * Claude Haiku gate for the tidy-mailboxes invoice forward: is this email
 * really a bill a SUPPLIER sent to the Haven (something finance needs), as
 * opposed to an invoice/receipt the Haven issued to a client, or a quote /
 * proposal / contract? Only runs on emails that already passed the keyword
 * pre-filter (src/lib/invoice-detection.ts), so it's a handful of calls a day.
 *
 * Founder rule (2026-09-28): faturas@ should only ever get supplier
 * invoices — never the ones the studio sends to clients, never quotes
 * ("propostas de orçamento"), "só mesmo faturas". Keywords can't tell
 * direction apart (a Stripe/Kenko copy of a receipt we issued looks just
 * like a supplier bill), hence an LLM.
 *
 * Fails toward NOT forwarding — the opposite of classify-mailbox-thread.ts.
 * A missed forward is recoverable (a founder forwards it by hand); spamming
 * faturas@ with non-invoices is exactly the complaint this exists to fix.
 */
import Anthropic from "@anthropic-ai/sdk";
import { log } from "../lib/log.js";
const MODEL = "claude-haiku-4-5";
const MAX_BODY_CHARS = 3000;
const SYSTEM_INSTRUCTION = "Analisas emails recebidos por um estúdio de Pilates (The Haven) que trazem um PDF/imagem anexado, para decidir se devem ser reencaminhados para o email de faturas da contabilidade. " +
    "Só interessa uma coisa: uma FATURA ou RECIBO emitido por um FORNECEDOR/prestador de serviços À The Haven — ou seja, algo que a The Haven tem de pagar ou já pagou (ex: fatura da limpeza, da renda, da eletricidade, de software, de uma compra online, de um instrutor externo). " +
    "Responde NAO_FATURA_FORNECEDOR em todos os outros casos, nomeadamente: " +
    "(a) faturas/recibos emitidos PELA The Haven a clientes/alunos (ex: recibo de uma compra de aulas ou pack, cópia de fatura enviada a um cliente, cliente a pedir ou a reenviar a fatura dele, notificações do Stripe/Kenko/software de faturação sobre vendas do estúdio); " +
    "(b) orçamentos, propostas, cotações, contratos, acordos — mesmo que falem de preços ou de faturação futura; " +
    "(c) avisos de pagamento, extratos, lembretes ou emails que só mencionam faturas sem trazer uma anexada; " +
    "(d) qualquer outra coisa. " +
    "Na dúvida, NAO_FATURA_FORNECEDOR. " +
    "Responde EXATAMENTE neste formato, nada mais:\nDECISÃO: FATURA_FORNECEDOR ou NAO_FATURA_FORNECEDOR\nRAZÃO: uma frase curta em pt-PT";
function fallback(reason) {
    return { isSupplierInvoice: false, reason, decided: false };
}
let client = null;
function getClient() {
    if (client)
        return client;
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) {
        log.warn("classify_invoice.no_api_key");
        return null;
    }
    client = new Anthropic({ apiKey: key });
    return client;
}
export async function classifyInvoice(params) {
    const c = getClient();
    if (!c)
        return fallback("sem ANTHROPIC_API_KEY — não reencaminhado por segurança");
    const prompt = [
        `Caixa: ${params.mailbox}`,
        `De: ${params.fromName} <${params.fromEmail}>`,
        `Assunto: ${params.subject}`,
        `Anexos: ${params.attachmentNames.join(", ")}`,
        "",
        params.body.slice(0, MAX_BODY_CHARS),
    ].join("\n");
    try {
        const response = await c.messages.create({
            model: MODEL,
            max_tokens: 150,
            system: [{ type: "text", text: SYSTEM_INSTRUCTION, cache_control: { type: "ephemeral" } }],
            messages: [{ role: "user", content: prompt }],
        });
        const text = response.content
            .filter((b) => b.type === "text")
            .map((b) => b.text)
            .join("")
            .trim();
        const decisionMatch = text.match(/DECIS[ÃA]O:\s*(NAO_FATURA_FORNECEDOR|FATURA_FORNECEDOR)/i);
        const reasonMatch = text.match(/RAZ[ÃA]O:\s*(.+)/i);
        if (!decisionMatch) {
            log.warn("classify_invoice.unparseable_response", { text: text.slice(0, 200) });
            return fallback("resposta do modelo não reconhecida — não reencaminhado por segurança");
        }
        return {
            isSupplierInvoice: (decisionMatch[1] ?? "").toUpperCase() === "FATURA_FORNECEDOR",
            reason: reasonMatch?.[1]?.trim() ?? "(sem razão)",
            decided: true,
        };
    }
    catch (err) {
        log.warn("classify_invoice.failed", {
            message: err instanceof Error ? err.message : String(err),
        });
        return fallback("erro na classificação — não reencaminhado por segurança");
    }
}
