import { getTelegramId } from "../lib/founders.js";
import { log } from "../lib/log.js";
import { sendDM } from "../lib/telegram.js";
import * as notion from "../notion.js";
function findTask(tasks, title) {
    const needle = title.toLowerCase();
    return tasks.find((t) => t.title.toLowerCase().includes(needle));
}
export async function handleSetDependency(ctx, chatCtx, intent) {
    try {
        const openTasks = chatCtx.openTasks;
        // Find or create prerequisite task.
        let prerequisiteTask = findTask(openTasks, intent.prerequisite);
        let prerequisiteId;
        if (prerequisiteTask) {
            prerequisiteId = prerequisiteTask.id;
        }
        else {
            prerequisiteId = await notion.createTask({
                title: intent.prerequisite,
                owner: intent.prerequisiteOwner,
                area: "Outro",
                why: "criada como pré-requisito via dependência",
            }, "Média", chatCtx.text, chatCtx.sender);
        }
        // Find or create blocked task.
        let blockedTask = findTask(openTasks, intent.blocked);
        let blockedId;
        if (blockedTask) {
            blockedId = blockedTask.id;
            // Ensure it's marked as Bloqueado.
            if (blockedTask.status !== "Bloqueado") {
                await notion.updateTask(blockedId, "status", "Bloqueado");
            }
        }
        else {
            blockedId = await notion.createTask({
                title: intent.blocked,
                owner: intent.blockedOwner,
                area: "Outro",
                why: `bloqueada até "${intent.prerequisite}" estar feita`,
            }, "Média", chatCtx.text, chatCtx.sender);
            await notion.updateTask(blockedId, "status", "Bloqueado");
        }
        // Link the dependency.
        await notion.setTaskDependency(blockedId, prerequisiteId);
        notion.invalidateOpenTasksCache();
        log.info("dependency.created", { blockedId, prerequisiteId });
        await ctx.reply(`🔗 dependência criada\n\n` +
            `⏳ *${intent.blocked}* — bloqueada\n` +
            `✅ aguarda: *${intent.prerequisite}*\n\n` +
            `Quando "${intent.prerequisite}" ficar feita, vou avisar ${intent.blockedOwner === "Unassigned" ? "o owner" : intent.blockedOwner}.`, { parse_mode: "Markdown" });
    }
    catch (err) {
        log.error("dependency.create_failed", { err: String(err) });
        await ctx.reply("erro a criar dependência — tenta outra vez");
    }
}
export async function checkAndUnblockDependents(completedTaskId, completedTitle) {
    try {
        const dependents = await notion.getDependentTasks(completedTaskId);
        if (dependents.length === 0)
            return;
        for (const task of dependents) {
            try {
                await notion.updateTask(task.id, "status", "A fazer");
                log.info("dependency.unblocked", {
                    taskId: task.id,
                    title: task.title,
                    prerequisite: completedTitle,
                });
                if (task.owner !== "Unassigned") {
                    const telegramId = getTelegramId(task.owner);
                    if (telegramId) {
                        await sendDM(telegramId, `✅ ${completedTitle} está feita — "${task.title}" está agora desbloqueada!`);
                    }
                }
            }
            catch (err) {
                log.error("dependency.unblock_failed", {
                    taskId: task.id,
                    err: String(err),
                });
            }
        }
        notion.invalidateOpenTasksCache();
    }
    catch (err) {
        log.error("dependency.check_failed", {
            completedTaskId,
            err: String(err),
        });
    }
}
