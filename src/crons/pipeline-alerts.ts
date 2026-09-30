import { alertKey, pruneStaleKeys } from "../lib/alert-dedup.js";
import { log } from "../lib/log.js";
import { sendGroupMessage } from "../lib/telegram.js";
import { weekOfYear } from "../lib/week.js";
import { formatContentAlert } from "../messages/pipeline.js";
import * as notion from "../notion.js";

// In-process dedup: resets on restart but acceptable — same alert won't fire
// twice on the same day under normal operation.
const seen = new Set<string>();

function todayLabel(): string {
  return new Date().toISOString().slice(0, 10);
}

async function processContentCalendar(today: string): Promise<number> {
  let rows: Awaited<ReturnType<typeof notion.getContentCalendarNeedsScheduling>>;
  try {
    rows = await notion.getContentCalendarNeedsScheduling();
  } catch (err) {
    log.warn("pipeline_alerts.content_fetch_failed", {
      message: err instanceof Error ? err.message : String(err),
    });
    return 0;
  }
  const unseen = rows.filter(
    (row) => !seen.has(alertKey(row.id, "content_calendar", today)),
  );
  if (unseen.length === 0) return 0;

  const text = formatContentAlert(unseen);
  try {
    await sendGroupMessage(text);
  } catch (err) {
    log.error("pipeline_alerts.group_send_failed", {
      message: err instanceof Error ? err.message : String(err),
    });
    return 0;
  }
  for (const row of unseen) {
    seen.add(alertKey(row.id, "content_calendar", today));
  }
  return unseen.length;
}

export async function run(): Promise<void> {
  const week = weekOfYear();
  const today = todayLabel();
  // Prune entries whose scope doesn't match today — content_calendar is the
  // only remaining dedup scope since the partner/influencer stale alerts
  // (weekly-scoped) were removed 2026-09-15.
  for (const key of pruneStaleKeys(seen, week, today)) {
    seen.delete(key);
  }
  const counts = {
    content_calendar: await processContentCalendar(today),
  };
  log.info("pipeline_alerts.done", { week, ...counts });
}
