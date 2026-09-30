import { log } from "../lib/log.js";
import * as notion from "../notion.js";
/**
 * Hourly: stamps the Backlog's "Concluído em" on tasks newly set to Feito,
 * and clears it on tasks that were reopened. The week balance reads
 * "done this week" from that date — see syncCompletionDates in
 * src/notion.ts for why it isn't last_edited_time.
 *
 * Schedule: every hour on the hour, Europe/Lisbon. Registered in src/server.ts.
 */
export async function run() {
    try {
        await notion.syncCompletionDates();
    }
    catch (err) {
        log.error("cron.completion_dates.failed", {
            message: err instanceof Error ? err.message : String(err),
        });
    }
}
