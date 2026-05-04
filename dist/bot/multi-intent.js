/**
 * Multi-intent extractor — single Haiku call replacing classifier +
 * extractor + the two phase-5 detectors.
 *
 * - System prompt = src/prompts/multi-intent.md, cached.
 * - User message = today's date + recent bot actions + open tasks +
 *   recent conversation + current message.
 * - Tool: `record_intents` with input { intents: Intent[] }.
 * - Validates each intent against the union; drops any that fail.
 * - Returns [] on API error or zero valid intents.
 */
import Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "node:fs";
import { log } from "../lib/log.js";
import * as notion from "../notion.js";
import { formatFeedbackAsFewShot } from "../prompts/feedback-examples.js";
const DEFAULT_MODEL = "claude-haiku-4-5-20251001";
const MAX_TOKENS = 1500;
const FOUNDERS = ["Madalena", "Mafalda", "Beatriz"];
const OWNERS = [...FOUNDERS, "Unassigned"];
const AREAS = [
    "Marketing", "Operações", "Parcerias", "Influencers",
    "Tech", "Cliente", "Financeiro", "Outro",
];
const LAUNCH_KINDS = [
    "programa-novo", "parceria", "evento", "influencer",
];
const EDIT_PENDING_FIELDS = [
    "owner", "area", "priority", "when", "title", "tags", "cancel",
];
const RECORD_INTENTS_TOOL = {
    name: "record_intents",
    description: "Record every actionable intent found in the message. Pass an empty array if nothing is actionable.",
    input_schema: {
        type: "object",
        properties: {
            intents: {
                type: "array",
                items: { type: "object" },
            },
        },
        required: ["intents"],
    },
};
let client = null;
let systemPromptBase = null;
let model = null;
function init() {
    if (!client) {
        const apiKey = process.env.ANTHROPIC_API_KEY;
        if (!apiKey)
            throw new Error("ANTHROPIC_API_KEY is not set");
        client = new Anthropic({ apiKey });
    }
    if (!systemPromptBase) {
        systemPromptBase = readFileSync(new URL("../prompts/multi-intent.md", import.meta.url), "utf8");
    }
    if (!model) {
        model = process.env.MULTI_INTENT_MODEL ?? DEFAULT_MODEL;
    }
    return { client, systemPromptBase, model };
}
function buildUserMessage(ctx) {
    const lines = [];
    const today = new Date().toLocaleDateString("pt-PT", {
        timeZone: "Europe/Lisbon",
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
    });
    lines.push(`Hoje: ${today} (Europe/Lisbon)`);
    lines.push("");
    if (ctx.recentBotActions.length > 0) {
        lines.push("Recent bot actions in this chat (last 10 min):");
        for (const a of ctx.recentBotActions) {
            lines.push(`${a.id}: ${a.type} ${a.status} — ${a.summary}`);
        }
        lines.push("");
    }
    if (ctx.openTasks.length > 0) {
        lines.push("Open tasks in Notion backlog:");
        for (const t of ctx.openTasks.slice(0, 50)) {
            lines.push(`  - ${t.id} | "${t.title}" | owner=${t.owner} | area=${t.area} | status=${t.status}`);
        }
        lines.push("");
    }
    if (ctx.recentMessages.length > 0) {
        lines.push("Recent conversation:");
        for (const m of ctx.recentMessages) {
            lines.push(`${m.sender}: ${m.text}`);
        }
        lines.push("");
    }
    lines.push("Current message:");
    lines.push(`${ctx.sender}: ${ctx.text}`);
    return lines.join("\n");
}
function isString(v) {
    return typeof v === "string" && v.length > 0;
}
function validateIntent(input) {
    if (!input || typeof input !== "object")
        return null;
    const o = input;
    switch (o.type) {
        case "NEW_TASK":
            if (!isString(o.title) ||
                typeof o.why !== "string" ||
                !OWNERS.includes(o.owner) ||
                !AREAS.includes(o.area))
                return null;
            return {
                type: "NEW_TASK",
                title: o.title.trim(),
                owner: o.owner,
                area: o.area,
                why: o.why,
            };
        case "EDIT_TASK":
            return { type: "EDIT_TASK" };
        case "REMINDER":
            if (!isString(o.when) ||
                !isString(o.text) ||
                !(o.for === "all" || FOUNDERS.includes(o.for)))
                return null;
            if (Number.isNaN(Date.parse(o.when)))
                return null;
            return {
                type: "REMINDER",
                when: o.when,
                text: o.text.trim(),
                for: o.for,
            };
        case "LOG":
            if (!isString(o.text))
                return null;
            return {
                type: "LOG",
                text: o.text.trim(),
                tags: Array.isArray(o.tags)
                    ? o.tags.filter((t) => typeof t === "string").slice(0, 3)
                    : [],
            };
        case "DECISION":
            if (!isString(o.text))
                return null;
            return {
                type: "DECISION",
                text: o.text.trim(),
                context: typeof o.context === "string" ? o.context : "",
            };
        case "LAUNCH_INTENT":
            if (!isString(o.what) ||
                !isString(o.when) ||
                !LAUNCH_KINDS.includes(o.kind))
                return null;
            return {
                type: "LAUNCH_INTENT",
                what: o.what.trim(),
                when: o.when,
                kind: o.kind,
            };
        case "EDIT_PENDING": {
            if (!isString(o.ref))
                return null;
            if (!EDIT_PENDING_FIELDS.includes(o.field))
                return null;
            const value = o.field === "cancel"
                ? null
                : (typeof o.value === "string" ? o.value : null);
            return {
                type: "EDIT_PENDING",
                ref: o.ref,
                field: o.field,
                value,
            };
        }
        default:
            return null;
    }
}
export function validateIntents(input) {
    if (!input || typeof input !== "object")
        return [];
    const o = input;
    if (!Array.isArray(o.intents))
        return [];
    return o.intents
        .map(validateIntent)
        .filter((i) => i !== null);
}
export async function extractIntents(ctx) {
    let runtime;
    try {
        runtime = init();
    }
    catch (err) {
        log.error("multi_intent.init_failed", { err: String(err) });
        return [];
    }
    let fewShot = "";
    try {
        const feedback = await notion.getRecentFeedback(20);
        fewShot = formatFeedbackAsFewShot(feedback);
    }
    catch (err) {
        log.warn("multi_intent.feedback_fetch_failed", { err: String(err) });
    }
    const systemBlocks = [
        {
            type: "text",
            text: fewShot
                ? `${runtime.systemPromptBase}\n\n${fewShot}`
                : runtime.systemPromptBase,
            cache_control: { type: "ephemeral" },
        },
    ];
    try {
        const response = await runtime.client.messages.create({
            model: runtime.model,
            max_tokens: MAX_TOKENS,
            system: systemBlocks,
            tools: [RECORD_INTENTS_TOOL],
            tool_choice: { type: "tool", name: "record_intents" },
            messages: [{ role: "user", content: buildUserMessage(ctx) }],
        });
        const toolUse = response.content.find((b) => b.type === "tool_use");
        if (!toolUse || toolUse.type !== "tool_use") {
            log.warn("multi_intent.no_tool_use", {
                stop_reason: response.stop_reason,
            });
            return [];
        }
        const intents = validateIntents(toolUse.input);
        log.info("multi_intent.extracted", {
            count: intents.length,
            types: intents.map((i) => i.type),
        });
        return intents;
    }
    catch (err) {
        log.error("multi_intent.api_error", { err: String(err) });
        return [];
    }
}
