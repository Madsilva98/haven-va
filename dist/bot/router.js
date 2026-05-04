/**
 * Intent router — takes the array from multi-intent.ts and dispatches
 * each intent to the right per-type handler. >=3 intents become a batch
 * summary card with [aceitar todas / rever / cancelar] buttons.
 */
import { log } from "../lib/log.js";
import { isBatch, postBatchCard } from "./batch.js";
import { proposeNewTask } from "./propose-task.js";
import { proposeEditFromContext } from "./propose-edit.js";
import { handleLog } from "./log-event.js";
import { proposeDecision } from "./decisions.js";
import { proposeLaunch } from "./launch.js";
import { createReminderFromIntent } from "./remind.js";
import { handleEditPending } from "./edit-pending.js";
export async function route(tgCtx, chatCtx, intents) {
    if (intents.length === 0)
        return;
    if (isBatch(intents)) {
        await postBatchCard(tgCtx, intents);
        return;
    }
    for (const intent of intents) {
        try {
            await dispatch(tgCtx, chatCtx, intent);
        }
        catch (err) {
            log.error("router.dispatch_failed", {
                type: intent.type,
                err: String(err),
            });
        }
    }
}
export async function dispatch(tgCtx, chatCtx, intent) {
    switch (intent.type) {
        case "NEW_TASK":
            await proposeNewTask(tgCtx, chatCtx, intent);
            return;
        case "EDIT_TASK":
            await proposeEditFromContext(tgCtx, chatCtx);
            return;
        case "REMINDER":
            await createReminderFromIntent(tgCtx, chatCtx.sender, {
                when: intent.when,
                text: intent.text,
                for: intent.for,
            });
            return;
        case "LOG":
            await handleLog(tgCtx, intent, chatCtx.sender, chatCtx.text);
            return;
        case "DECISION":
            await proposeDecision(tgCtx, adaptDecision(intent, chatCtx.sender), chatCtx.text, chatCtx.sender);
            return;
        case "LAUNCH_INTENT":
            await proposeLaunch(tgCtx, adaptLaunch(intent), chatCtx.text, chatCtx.sender);
            return;
        case "EDIT_PENDING":
            await handleEditPending(tgCtx, chatCtx, intent);
            return;
    }
}
function adaptDecision(intent, sender) {
    return {
        decisao: intent.text,
        area: "Outro",
        tomadaPor: [sender],
        notas: intent.context,
    };
}
function adaptLaunch(intent) {
    // multi-intent's `kind` (LaunchKind) is the same string literal union as
    // LaunchTemplateId — assigned directly, no cast required.
    return {
        name: intent.what,
        templateId: intent.kind,
        launchDate: intent.when,
        owner: "Unassigned",
    };
}
