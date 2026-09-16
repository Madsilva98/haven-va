/**
 * Single Claude Haiku call classifying whether an inbound email is a
 * genuine "I want to know more" lead, for src/crons/leads-email-scan.ts.
 * Same singleton-init pattern as src/bot/assistant.ts's initRuntime().
 */
import { readFileSync } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import { log } from "./log.js";
const DEFAULT_MODEL = "claude-haiku-4-5-20251001";
let anthropicClient = null;
let promptText = null;
function initRuntime() {
    if (!anthropicClient) {
        const apiKey = process.env.ANTHROPIC_API_KEY;
        if (!apiKey)
            throw new Error("ANTHROPIC_API_KEY is not set");
        anthropicClient = new Anthropic({ apiKey });
    }
    if (!promptText) {
        promptText = readFileSync(new URL("../prompts/lead-classifier.md", import.meta.url), "utf8");
    }
    const model = process.env.LEAD_CLASSIFIER_MODEL ?? DEFAULT_MODEL;
    return { client: anthropicClient, prompt: promptText, model };
}
/**
 * `text` should be the email's subject + body (plain text). Defaults to
 * false (don't classify as a lead) on any API error — a missed lead is
 * far cheaper than a crashed weekly cron.
 */
export async function isGenuineInformationRequest(text) {
    const { client, prompt, model } = initRuntime();
    try {
        const response = await client.messages.create({
            model,
            max_tokens: 20,
            system: prompt,
            messages: [{ role: "user", content: text.slice(0, 8000) }],
        });
        const block = response.content.find((b) => b.type === "text");
        const answer = block && block.type === "text" ? block.text.trim().toUpperCase() : "";
        return answer.startsWith("SIM");
    }
    catch (err) {
        log.warn("lead_classifier.request_failed", {
            message: err instanceof Error ? err.message : String(err),
        });
        return false;
    }
}
