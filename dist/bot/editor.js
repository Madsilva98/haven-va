/**
 * Tier 2b editor — Haiku call that maps a chat message onto an
 * existing open task and proposes a single-field edit.
 *
 * - Pulls the current open-task list from notion (60s cache there)
 *   and substitutes it into the prompt so the model can pick a target.
 * - Tool: `record_edit`. tool_choice = "auto" because some messages
 *   look like edits but have no clear target — we'd rather get back
 *   no tool call than a hallucinated id.
 * - Validates that the chosen targetTaskId is actually in the open
 *   list. If not, return null so the caller drops it.
 */
import Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "node:fs";
import { log } from "../lib/log.js";
import * as notion from "../notion.js";
const DEFAULT_MODEL = "claude-haiku-4-5-20251001";
const MAX_TOKENS = 512;
const EDITABLE_FIELDS = [
    "status",
    "owner",
    "deadline",
    "prioridade",
    "area",
];
const RECORD_EDIT_TOOL = {
    name: "record_edit",
    description: "Record an edit to an existing open task. Only call when the message clearly references one of the listed open tasks. If unsure, do not call this tool.",
    input_schema: {
        type: "object",
        properties: {
            targetTaskId: {
                type: "string",
                description: "The id of the open task being edited (must match the list).",
            },
            targetTitle: {
                type: "string",
                description: "The title of the target task as listed.",
            },
            field: {
                type: "string",
                enum: EDITABLE_FIELDS,
                description: "Which field of the task is being changed.",
            },
            oldValue: {
                type: "string",
                description: "Current value of the field as it appears in the open task list.",
            },
            newValue: {
                type: "string",
                description: "New value the user wants to set.",
            },
        },
        required: ["targetTaskId", "targetTitle", "field", "oldValue", "newValue"],
    },
};
let client = null;
let systemPromptBase = null;
let model = null;
function init() {
    if (!client) {
        const apiKey = process.env.ANTHROPIC_API_KEY;
        if (!apiKey) {
            throw new Error("ANTHROPIC_API_KEY is not set");
        }
        client = new Anthropic({ apiKey });
    }
    if (!systemPromptBase) {
        const promptUrl = new URL("../prompts/extract-edit.md", import.meta.url);
        systemPromptBase = readFileSync(promptUrl, "utf8");
    }
    if (!model) {
        model = process.env.EXTRACTOR_MODEL ?? DEFAULT_MODEL;
    }
    return { client, systemPromptBase, model };
}
function compactOpenTasks(tasks) {
    return tasks.map((t) => ({
        id: t.id,
        title: t.title,
        owner: t.owner,
        area: t.area,
        priority: t.priority,
        deadline: t.deadline,
        status: t.status,
    }));
}
function buildUserMessage(ctx) {
    const lines = [];
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
function validate(input, openTaskIds) {
    if (!input || typeof input !== "object")
        return null;
    const obj = input;
    const { targetTaskId, targetTitle, field, oldValue, newValue } = obj;
    if (typeof targetTaskId !== "string" || !openTaskIds.has(targetTaskId)) {
        return null;
    }
    if (typeof targetTitle !== "string")
        return null;
    if (typeof field !== "string" ||
        !EDITABLE_FIELDS.includes(field)) {
        return null;
    }
    if (typeof oldValue !== "string")
        return null;
    if (typeof newValue !== "string")
        return null;
    return {
        targetTaskId,
        targetTitle,
        field: field,
        oldValue,
        newValue,
    };
}
export async function extractEdit(ctx) {
    let runtime;
    try {
        runtime = init();
    }
    catch (err) {
        log.error("editor.init_failed", { err: String(err) });
        return null;
    }
    let openTasks;
    try {
        openTasks = await notion.getOpenTasks();
    }
    catch (err) {
        log.error("editor.open_tasks_fetch_failed", { err: String(err) });
        return null;
    }
    if (openTasks.length === 0) {
        // Nothing to edit.
        return null;
    }
    const compact = compactOpenTasks(openTasks);
    const openTasksJson = JSON.stringify(compact, null, 2);
    const filledPrompt = runtime.systemPromptBase.includes("{{OPEN_TASKS}}")
        ? runtime.systemPromptBase.replace("{{OPEN_TASKS}}", openTasksJson)
        : `${runtime.systemPromptBase}\n\nOpen tasks:\n${openTasksJson}`;
    const systemBlocks = [
        {
            type: "text",
            text: filledPrompt,
            cache_control: { type: "ephemeral" },
        },
    ];
    const openTaskIds = new Set(openTasks.map((t) => t.id));
    try {
        const response = await runtime.client.messages.create({
            model: runtime.model,
            max_tokens: MAX_TOKENS,
            system: systemBlocks,
            tools: [RECORD_EDIT_TOOL],
            tool_choice: { type: "auto" },
            messages: [{ role: "user", content: buildUserMessage(ctx) }],
        });
        const toolUse = response.content.find((b) => b.type === "tool_use");
        if (!toolUse || toolUse.type !== "tool_use") {
            // Model declined — no clear target. Drop quietly.
            return null;
        }
        const validated = validate(toolUse.input, openTaskIds);
        if (!validated) {
            log.warn("editor.validation_failed", { input: toolUse.input });
            return null;
        }
        return validated;
    }
    catch (err) {
        log.error("editor.api_error", { err: String(err) });
        return null;
    }
}
