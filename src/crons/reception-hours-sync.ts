import { listCalendarEventsStrict, type CalendarEvent } from "../lib/calendar.js";
import { isStudioDbAvailable, withTransaction } from "../lib/studio-db.js";
import { log } from "../lib/log.js";

/**
 * Copies the "Receção" Google Calendar into the studio database, so the front
 * desk pay reads the shifts from the calendar (Mafalda, 2026-10-01).
 *
 * The bot only copies: every timed event from the cut-over date to the end of
 * the 4th month ahead goes to va.reception_calendar_events (insert / update /
 * delete is all haven_va may do there). Every row gets synced_at = now(), so the
 * studio tells a worked shift (end_at <= synced_at) from a scheduled one, which
 * feeds the front desk forecast. Which events count — the title "Peres de
 * Almeida", from 2026-09-01 — is the studio's rule, in
 * finance.v_front_desk_hours, not here. An event deleted from the calendar is
 * deleted on the next run.
 *
 * Schedule: 23:30 Europe/Lisbon every day, after the last shift (they end by
 * 22:00). Registered in src/server.ts.
 */

export const RECEPTION_CALENDAR = "Receção";
export const SYNC_FROM = new Date("2026-09-01T00:00:00+01:00");
export const MONTHS_AHEAD = 4;

/** End of the copy window: the start of the month after the MONTHS_AHEAD-th month from `now` (UTC). */
export function syncUntil(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + MONTHS_AHEAD + 1, 1));
}

export interface ReceptionRow {
  event_id: string;
  calendar_id: string;
  title: string;
  start_at: string;
  end_at: string;
}

/** The rows to keep: timed events starting in [SYNC_FROM, until), past and future. */
export function rowsToSync(events: CalendarEvent[], until: Date): ReceptionRow[] {
  return events
    .filter((e) => e.id && !e.allDay)
    .filter((e) => !Number.isNaN(e.start.getTime()) && !Number.isNaN(e.end.getTime()))
    .filter((e) => e.start >= SYNC_FROM && e.start < until && e.end > e.start)
    .map((e) => ({
      event_id: e.id,
      calendar_id: e.calendarId,
      title: e.title,
      start_at: e.start.toISOString(),
      end_at: e.end.toISOString(),
    }));
}

export async function run(now: Date = new Date()): Promise<void> {
  if (!isStudioDbAvailable()) {
    log.warn("cron.reception_hours_sync.no_db");
    return;
  }

  const until = syncUntil(now);
  let events: CalendarEvent[];
  try {
    events = await listCalendarEventsStrict(RECEPTION_CALENDAR, SYNC_FROM, until);
  } catch (err) {
    // Nothing is written or deleted when the calendar can't be read.
    log.error("cron.reception_hours_sync.fetch_failed", { message: err instanceof Error ? err.message : String(err) });
    return;
  }

  const rows = rowsToSync(events, until);
  if (rows.length === 0) {
    // An empty answer for a calendar with weeks of shifts is more likely a
    // problem than the truth: keep what is stored.
    log.warn("cron.reception_hours_sync.empty", { fetched: events.length });
    return;
  }

  const deleted = await withTransaction(async (client) => {
    for (const r of rows) {
      await client.query(
        `insert into reception_calendar_events (event_id, calendar_id, title, start_at, end_at, synced_at)
         values ($1, $2, $3, $4, $5, now())
         on conflict (event_id) do update set calendar_id = excluded.calendar_id, title = excluded.title,
           start_at = excluded.start_at, end_at = excluded.end_at, synced_at = now()`,
        [r.event_id, r.calendar_id, r.title, r.start_at, r.end_at],
      );
    }
    const res = await client.query(
      `delete from reception_calendar_events where not (event_id = any($1::text[]))`,
      [rows.map((r) => r.event_id)],
    );
    return res.rowCount ?? 0;
  });

  log.info("cron.reception_hours_sync.done", { synced: rows.length, deleted, fetched: events.length });
}
