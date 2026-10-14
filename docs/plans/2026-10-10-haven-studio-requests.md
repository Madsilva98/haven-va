# Request for haven-studio — contact status view (2026-10-10)

From haven-va's Google Contacts sync (`src/crons/google-contacts-sync.ts`, decisions by Mafalda
2026-10-10). haven-va's database role is read-only, so this needs a haven-studio session.

## Apply the bot's view

Run haven-va `scripts/studio-db-contact-status-2026-10-10.sql` as is: one `create or replace view
va.v_pulse_contact_status`, its comment, and `grant select ... to haven_va`.

- **What it is:** one row per `member_id` in `va.v_pulse_member_identity`, one column `status` — the ONE
  label the person carries in the studio's Google Contacts (Member / Class pack / Former member / Idle
  intro pack / Active intro pack / Trying to convert / Cold lead / Lead, first match wins).
- **Data-model review:** done on the haven-va side against the live database, written in the SQL file's
  header. It is a bot analysis view under check C6: it reads only `va.v_pulse_member_identity`,
  `va.v_pulse_customer_journey` and `va.v_pulse_intro_pack_tracking`, recomputes no rule (it reads
  `now_state`, `auto_state`, `reasons`), contains no `rule-owners.json` fingerprint, and carries no PII
  (`member_id` only). Please re-run the gate on your side before applying.
- **After applying:** `node scripts/data-model-check.mjs` must add no NEW line. The next va rebuild saves
  the view in `public.va_bot_views`; it reads another bot view (`v_pulse_intro_pack_tracking`), which the
  rebuild's retry loop handles.
- **Check:** `select status, count(*) from va.v_pulse_contact_status s join va.v_pulse_member_identity i
  using (member_id) where i.contact_phone ~ '[0-9]' group by 1` — on 2026-10-10: Member 78, Class pack 5,
  Former member 30, Idle intro pack 24, Active intro pack 21, Trying to convert 15, Cold lead 250,
  Lead 167 (590, no NULL).

## One thing to keep in mind

A new `now_state` in `v_pulse_customer_journey` makes this view return NULL for those people, and the
bot then stops its whole run and alerts (it never guesses a label). So a new state there needs a line
in this view, and its label in haven-va `src/lib/contacts-sync.ts` `STATUS_LABELS`.

Until the view is applied the cron fails on its first query, writes nothing, and says so on Telegram —
but only once `/authcontacts` has been done, so apply this first.
