/**
 * Phase 5 — Apply a launch template.
 *
 * Pure function: takes a `LaunchExtraction` (the bot's parsed
 * "vamos lançar X a Y" intent) and produces the list of tasks that
 * the user can confirm. Does NOT write to Notion — the caller proposes
 * the list via inline keyboard and only writes after explicit confirm.
 */
import { LAUNCH_TEMPLATES } from "../prompts/launch-templates.js";
function addDaysIso(iso, days) {
    // `iso` is `YYYY-MM-DD`. Build a UTC date so DST / local-tz never shifts it.
    const d = new Date(`${iso}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
}
export function generateTasksFromTemplate(extraction) {
    const template = LAUNCH_TEMPLATES[extraction.templateId];
    return template.map((t) => ({
        title: t.title.replace("{name}", extraction.name),
        // The launch owner from the extraction wins for the "ownership"
        // dimension; the template's per-task ownerHint stays as the assignee
        // because Madalena doesn't write all the copy herself.
        owner: t.ownerHint,
        area: t.area,
        deadline: addDaysIso(extraction.launchDate, t.daysFromLaunch),
        priority: t.priority,
    }));
}
