/**
 * Single Claude Haiku call classifying whether an inbound message is a
 * genuine "I want to know more" lead. Two prompt variants share the same
 * client/error-handling: "email" for src/crons/leads-email-scan.ts,
 * "dm" for src/crons/leads-instagram-scan.ts's DM transcripts. Same
 * singleton-init pattern as src/bot/assistant.ts's initRuntime().
 */
import { readFileSync } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import { log } from "./log.js";
const DEFAULT_MODEL = "claude-haiku-4-5-20251001";
const PROMPT_FILES = {
    email: "../prompts/lead-classifier.md",
    dm: "../prompts/lead-classifier-dm.md",
    partnerEnrichment: "../prompts/partner-enrichment.md",
    influencerEnrichment: "../prompts/influencer-enrichment.md",
    relationshipLogUpdate: "../prompts/relationship-log-update.md",
};
let anthropicClient = null;
const promptCache = new Map();
function initRuntime(promptKey) {
    if (!anthropicClient) {
        const apiKey = process.env.ANTHROPIC_API_KEY;
        if (!apiKey)
            throw new Error("ANTHROPIC_API_KEY is not set");
        anthropicClient = new Anthropic({ apiKey });
    }
    let prompt = promptCache.get(promptKey);
    if (!prompt) {
        prompt = readFileSync(new URL(PROMPT_FILES[promptKey], import.meta.url), "utf8");
        promptCache.set(promptKey, prompt);
    }
    const model = process.env.LEAD_CLASSIFIER_MODEL ?? DEFAULT_MODEL;
    return { client: anthropicClient, prompt, model };
}
/**
 * Returns the model's raw trimmed/uppercased one-word answer, or "" on any
 * API error — callers decide their own safe default from that, but every
 * prompt variant here is written to bias toward the cheapest-to-miss
 * outcome (NÃO/NENHUM) when uncertain, so "" behaves the same way a
 * genuine NÃO/NENHUM answer would in every caller below.
 */
async function callClassifier(text, promptKey) {
    const { client, prompt, model } = initRuntime(promptKey);
    try {
        const response = await client.messages.create({
            model,
            max_tokens: 20,
            system: prompt,
            messages: [{ role: "user", content: text.slice(0, 8000) }],
        });
        const block = response.content.find((b) => b.type === "text");
        return block && block.type === "text" ? block.text.trim().toUpperCase() : "";
    }
    catch (err) {
        log.warn("lead_classifier.request_failed", {
            promptKey,
            message: err instanceof Error ? err.message : String(err),
        });
        return "";
    }
}
/**
 * Same client/prompt-cache machinery as callClassifier, but for a longer
 * freeform reply (a summary, not a one-word category) — higher max_tokens,
 * no uppercasing (would mangle prose). Returns "" on any API error, same
 * as callClassifier; callers treat that as "skip, nothing to write."
 */
async function callFreeform(text, promptKey, maxTokens) {
    const { client, prompt, model } = initRuntime(promptKey);
    try {
        const response = await client.messages.create({
            model,
            max_tokens: maxTokens,
            system: prompt,
            messages: [{ role: "user", content: text.slice(0, 8000) }],
        });
        const block = response.content.find((b) => b.type === "text");
        return block && block.type === "text" ? block.text.trim() : "";
    }
    catch (err) {
        log.warn("lead_classifier.request_failed", {
            promptKey,
            message: err instanceof Error ? err.message : String(err),
        });
        return "";
    }
}
/** Pulls a `LABEL: value` line out of a callFreeform reply. "NADA" (the
 * prompts' explicit "nothing here" sentinel) becomes null, same spirit as
 * NENHUM elsewhere in this file. Missing label also becomes null — an
 * API hiccup or a malformed reply should look like "nothing to write",
 * never crash the caller. */
function extractField(reply, label) {
    const match = reply.match(new RegExp(`^${label}:\\s*(.*)$`, "im"));
    const value = match?.[1]?.trim();
    if (!value || value.toUpperCase() === "NADA")
        return null;
    return value;
}
/**
 * `transcript` should be the contact's full Cliente/Haven DM transcript
 * (same shape classifyInstagramDM takes). Returns null only on total API
 * failure (logged already by callFreeform) — caller skips enrichment for
 * this run and leaves the checkpoint stale so it retries next time.
 */
export async function enrichPartnerFromTranscript(transcript) {
    const reply = await callFreeform(transcript, "partnerEnrichment", 500);
    if (!reply)
        return null;
    return {
        sobre: extractField(reply, "SOBRE"),
        deal: extractField(reply, "DEAL"),
        log: extractField(reply, "LOG") ?? "",
    };
}
export async function enrichInfluencerFromTranscript(transcript) {
    const reply = await callFreeform(transcript, "influencerEnrichment", 400);
    if (!reply)
        return null;
    return {
        sobre: extractField(reply, "SOBRE"),
        log: extractField(reply, "LOG") ?? "",
    };
}
/**
 * `deltaTranscript` should be built from only the NEW messages since the
 * last enrichment pass (see leads-instagram-scan.ts's reEnrichContact) —
 * not the whole conversation. Returns "" on API failure or an empty reply;
 * caller skips appending a Log entry in that case rather than writing
 * nothing useful.
 */
export async function summarizeRelationshipUpdate(deltaTranscript) {
    return callFreeform(deltaTranscript, "relationshipLogUpdate", 200);
}
/** `text` should be the email's subject + body (plain text). */
export async function isGenuineInformationRequest(text) {
    const answer = await callClassifier(text, "email");
    return answer.startsWith("SIM");
}
/**
 * `text` should be a chronological Cliente/Haven Instagram DM transcript.
 * "cliente" = genuine information request from a prospective client;
 * "parceiro" = another business/professional proposing a genuine business
 * collaboration (workshop, event, corporate, cross-promotion — not about
 * content/social media); "influencer" = a content creator offering to try
 * a class in exchange for posting about it; "nenhum" = none of the above —
 * including job applications and vendor/supplier sales pitches, which are
 * deliberately excluded from "parceiro" (founder's call, 2026-09-21: those
 * aren't partnerships, they're the opposite — someone selling to us, or
 * applying to us). Also the fallback for an API error or unrecognized
 * answer.
 */
export async function classifyInstagramDM(text) {
    const answer = await callClassifier(text, "dm");
    if (answer.startsWith("CLIENTE"))
        return "cliente";
    if (answer.startsWith("PARCEIRO"))
        return "parceiro";
    if (answer.startsWith("INFLUENCER"))
        return "influencer";
    return "nenhum";
}
