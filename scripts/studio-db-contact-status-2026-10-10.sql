-- va.v_pulse_contact_status — the ONE status label each studio contact carries in Google Contacts
-- (Mafalda, 2026-10-10). Read by haven-va src/crons/google-contacts-sync.ts, which only writes what
-- this view says into the studio's Google account; the rule is here, never in TypeScript.
--
-- HOW THIS GETS APPLIED. haven-va's role is read-only; this needs a haven-studio session (Management
-- API), like scripts/studio-db-intro-pack-tracking-2026-10-02.sql. Run the `create or replace view`
-- below as is. It reads only va objects, so it is a bot analysis view under haven-studio's data-model
-- check C6; the va rebuild saves it in public.va_bot_views and recreates it (it reads another bot view,
-- va.v_pulse_intro_pack_tracking: the rebuild's retry loop handles that order).
-- Until it is applied the cron fails on its first query and says so on Telegram; nothing is written.
--
-- DATA-MODEL REVIEW (haven-studio .claude/skills/data-model-review, run 2026-10-10 against the live DB):
--   1. Concept: the contact's status label, a bot-only classification. No registry row answers it;
--      it cannot be a column on public.v_pulse_customer_journey (acquisition canonical) because rules
--      4, 6 and 7 read va.v_pulse_intro_pack_tracking, a bot view that public objects may not read.
--   2. Grain: one row per member_id in va.v_pulse_member_identity. Live: 1071 rows, 1071 distinct
--      member_id before and after both joins (journey 519 / 519, tracking 352 / 352: no fan-out).
--   3. No rule written twice: now_state, auto_state and reasons are read, not recomputed. No
--      rule-owners.json fingerprint in the definition (no clock, no product regex, no checkin_status).
--   4. Layers: reads va.v_pulse_member_identity, va.v_pulse_customer_journey and
--      va.v_pulse_intro_pack_tracking only (C6).
--   5. Numbers: a new object, so nothing existing moves. The 590 people with a phone on 2026-10-10:
--      Member 78, Class pack 5, Former member 30, Idle intro pack 24, Active intro pack 21,
--      Trying to convert 15, Cold lead 250, Lead 167 (sum 590, no null).
--   6. PII: member_id only. Name and phone stay in v_pulse_member_identity ("never copy these columns
--      into another view"); the bot joins them in its own query.
--   Verdict: SHIP, as a bot analysis view. After applying, run scripts/data-model-check.mjs in
--   haven-studio: it must add no NEW line.
--
-- The label, first match wins (Mafalda, 2026-10-10):
--   1. Member             now_state in (member, paused)
--   2. Class pack         now_state = pack
--   3. Former member      now_state = left
--   4. Idle intro pack    the tracking view's auto_state = idle
--   5. Active intro pack  now_state in (intro, intro_waiting)
--   6. Trying to convert  the tracking view's reasons contain pack_ended, and its auto_state is not
--                         converted / bought_other / cold_lead
--   7. Cold lead          auto_state = cold_lead, or now_state = not_active with none of the above
--   8. Lead               not in v_pulse_customer_journey (never bought)
-- A now_state this list does not know gives NULL: the bot then stops the whole run and alerts, so a
-- new state is added here on purpose, never guessed.

create or replace view va.v_pulse_contact_status as
select i.member_id,
  case
    when j.now_state in ('member', 'paused') then 'Member'
    when j.now_state = 'pack' then 'Class pack'
    when j.now_state = 'left' then 'Former member'
    when t.auto_state = 'idle' then 'Idle intro pack'
    when j.now_state in ('intro', 'intro_waiting') then 'Active intro pack'
    when 'pack_ended' = any (t.reasons)
         and coalesce(t.auto_state, '') not in ('converted', 'bought_other', 'cold_lead') then 'Trying to convert'
    when t.auto_state = 'cold_lead' or j.now_state = 'not_active' then 'Cold lead'
    when j.member_id is null then 'Lead'
  end as status
from va.v_pulse_member_identity i
left join va.v_pulse_customer_journey j on j.member_id = i.member_id
left join va.v_pulse_intro_pack_tracking t on t.member_id = i.member_id;

comment on view va.v_pulse_contact_status is 'Haven VA bot''s own view (haven-va scripts/studio-db-contact-status-2026-10-10.sql): one row per member_id in v_pulse_member_identity, with the ONE status label the person carries in the studio''s Google Contacts (Mafalda 2026-10-10). First match wins: Member (now_state member / paused), Class pack (pack), Former member (left), Idle intro pack (intro pack tracking auto_state idle), Active intro pack (now_state intro / intro_waiting), Trying to convert (tracking reasons contain pack_ended, auto_state not converted / bought_other / cold_lead), Cold lead (auto_state cold_lead, or now_state not_active with none of the above), Lead (not in v_pulse_customer_journey: never bought). NULL = a now_state this list does not know; the bot stops and alerts. No PII here: name and phone are joined from v_pulse_member_identity by the reader.';

grant select on va.v_pulse_contact_status to haven_va;
