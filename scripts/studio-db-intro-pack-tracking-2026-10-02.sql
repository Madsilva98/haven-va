-- va.v_pulse_intro_pack_tracking — the "Tracking intro packs" Notion list's rules, as one view
-- (founder, 2026-10-02: "devias criar views ... para não fazeres erros a calcular coisas everytime").
-- Read by haven-va src/crons/intro-pack-tracking.ts, which only writes what this view says into Notion.
--
-- Full request list for haven-studio (incl. the 2-Class pack-end rule for is_lead / pack_ended_on):
-- docs/plans/2026-10-02-haven-studio-requests.md.
--
-- HOW THIS GETS APPLIED. haven-va's role is read-only; this needs a haven-studio session (Management API):
--   1. FIRST add `booked_ahead` to public.v_pulse_member_activity (canonical owner of bookings) — the number
--      of classes the person has booked (status Booked, not cancelled, not waitlist) on a day AFTER
--      v_pulse_data_as_of — then re-apply va-schema-and-role-migration.sql so va.v_pulse_member_activity
--      carries it. The bot cannot compute it: per-person future bookings live only in kenko_bookings.
--   2. THEN run the `create or replace view` below. It reads only va copies, so it is a bot analysis view
--      under haven-studio's data-model check C6; the va rebuild saves it in public.va_bot_views and
--      recreates it. Grant select to haven_va like the other va views.
-- Until both are done the bot keeps posting the old 08:15 digest (it switches only once
-- NOTION_INTRO_TRACKING_DB_ID is set on the NAS — set that AFTER applying this).
--
-- One row per intro buyer whose intro (v_pulse_intro_outcome's pick: the first pack that ran) is a 2-Class
-- or 10-Day pack. Two answers per row, both null when nothing applies today:
--   reason      — why the person belongs on the list now (the bot adds them only if not there yet,
--                 and refreshes Motivo to the latest reason): waiting_to_start / underused / pack_ending /
--                 pack_ended.
--   auto_state  — the state the bot sets on its own: converted (a membership) / bought_other (a class
--                 pack) / cold_lead (20 days after the end, not converted) / idle (never started, 30 days
--                 after purchase, nothing booked). A drop-in is neither: the person stays.
--
-- Every time rule counts to data_as_of, never the calendar (founder, 2026-10-02: the Kenko import is
-- manual and can lag) — a stale import delays a decision, it never makes a wrong one. The one exception
-- is pack_ending's "5 days or less left", a forward-looking window on a fixed calendar fact (intro_end),
-- which reads current_date like the old watch list did (2026-09-22: on a lagging data date "ending soon"
-- became "already over"). Entering the list is harmless; leaving it is what waits for the data.
--
-- Founder's rules (2026-10-02 interview):
--   not started  = 0 classes on the pack. Listed from 7 days after purchase (waiting_to_start), unless a
--                  first class is already booked; idle at 30 days with nothing booked (= studio setting
--                  idle_intro_days). The 20-day rule never applies: an unstarted pack has no real end.
--   pack ended   = founder, verbatim: "the end of the pack, on the 2 day intro pack, IS the day of the last
--                  [class]. this rule applies ALWAYS. if the 2nd class doesn't exist, then yes the pack has
--                  an expiry date (2 weeks after the first class)". 2-Class with the 2nd class done → the
--                  2nd class; otherwise, and any other pack, Kenko's expiry. (pack_ended_on still says "1
--                  class used = that class" — requested fix, see the requests doc.)
--   cold_lead    = 20 days after that end, not converted. leads-intro-pack.ts (Monday, is_lead, 21 days)
--                  is unchanged and adds them to "Leads a contactar" — unless marked Perdido here.
--   pack_ending  = 2-Class with 1 class used and none booked ahead, or any 10-Day, 0-5 days to expiry.
--   underused    = 10-Day, 1-2 classes, 5+ days since the first class on the pack.

create or replace view va.v_pulse_intro_pack_tracking as
with s as (select data_as_of as asof from va.v_pulse_data_as_of),
base as (
  select o.member_id, o.email, o.item_name, o.pack_group as pack, o.bought_on,
         p.first_class_on,
         o.ended_on as expires_on,
         case when o.pack_group = '2-Class' and o.visits_in_pack >= 2 then o.pack_ended_on
              else o.ended_on end as ended_on,
         o.visits_in_pack,
         coalesce(a.booked_ahead, 0) as booked_ahead,
         o.outcome,
         s.asof as data_as_of
  from va.v_pulse_intro_outcome o
  cross join s
  left join va.v_pulse_intro_purchase p on p.sale_id = o.sale_id
  left join va.v_pulse_member_activity a on a.member_id = o.member_id
  where o.pack_group in ('2-Class', '10-Day') and not o.is_event
    and (o.tracked
         -- tracked needs an activated pack; an unstarted one passes the same "not already a customer" test here
         or (o.visits_in_pack = 0
             and not exists (select 1 from va.v_pulse_membership_state ms
                             where ms.member_id = o.member_id and ms.is_paying_cycle and ms.cycle_starts_at < o.bought_on)
             and not exists (select 1 from va.v_pulse_classpack_state cp
                             where cp.member_id = o.member_id and cp.started < o.bought_on)))
),
f as (
  select b.*,
         b.visits_in_pack = 0 as not_started,
         (b.pack = '2-Class' and b.visits_in_pack >= 2) or b.data_as_of > b.expires_on as pack_over
  from base b
)
select f.member_id, f.email, f.item_name, f.pack, f.bought_on, f.first_class_on, f.expires_on, f.ended_on,
  f.visits_in_pack, f.booked_ahead, f.outcome, f.data_as_of,
  case when f.outcome = 'member' then 'converted'
       when f.outcome = 'pack' then 'bought_other'
       when f.not_started and f.booked_ahead = 0 and f.data_as_of - f.bought_on >= 30 then 'idle'
       when not f.not_started and f.pack_over and f.data_as_of - f.ended_on >= 20 then 'cold_lead'
  end as auto_state,
  case when f.outcome in ('member', 'pack') then null
       when f.not_started then
         case when f.booked_ahead = 0 and f.data_as_of - f.bought_on between 7 and 29 then 'waiting_to_start' end
       when f.pack_over then
         case when f.data_as_of - f.ended_on < 20 then 'pack_ended' end
       when f.expires_on - current_date between 0 and 5
            and (f.pack = '10-Day' or (f.visits_in_pack = 1 and f.booked_ahead = 0)) then 'pack_ending'
       when f.pack = '10-Day' and f.visits_in_pack between 1 and 2
            and f.data_as_of - f.first_class_on >= 5 then 'underused'
  end as reason
from f;

comment on view va.v_pulse_intro_pack_tracking is 'Haven VA bot''s own view (haven-va scripts/studio-db-intro-pack-tracking-2026-10-02.sql): one row per 2-Class/10-Day intro buyer for the "Tracking intro packs" Notion list. reason = why they belong on the list today (waiting_to_start: 0 classes, 7-29 days since purchase, nothing booked; underused: 10-Day, 1-2 classes, 5+ days since the first; pack_ending: 0-5 calendar days to expiry, 10-Day or 2-Class with 1 class and none booked; pack_ended: under 20 days since the end). auto_state = what the bot sets on its own: converted (membership), bought_other (class pack), cold_lead (20+ days since the end, not converted), idle (never started, 30+ days, nothing booked). A 2-Class pack with both classes ends on the 2nd class, any other on expiry. Time rules count to data_as_of; pack_ending reads the calendar.';

grant select on va.v_pulse_intro_pack_tracking to haven_va;
