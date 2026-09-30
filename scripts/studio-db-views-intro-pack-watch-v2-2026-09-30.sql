-- Replaces va.v_pulse_intro_pack_watch from scripts/studio-db-views-2026-09-30.sql
-- (already applied to production) with the founder's revised rules, same
-- day. Founder's own words, verbatim:
--
--   "não estamos a apanhar as pessoas com 2 class intro pack e fizeram as
--   duas aulas. quero apanhar estes perto de fazerem a 2ª aula, para fazer
--   follow up" — 2-Class needed a second bucket: people who FINISHED both
--   classes, for a conversion follow-up, not just people who haven't used
--   their 2nd class yet.
--
--   "1 of 2 used mantém-se, mas em vez de ser this week, como é diário,
--   acho que podemos fazer 'faltam 5 dias para expirar e não tem a 2ª aula
--   booked'" — replaces the "this calendar week" window with a rolling
--   5-day window (this cron runs daily, so a rolling window is simpler
--   than a Monday-Sunday one and doesn't miss anyone with under 5 days
--   left later in the week), plus a new exclusion: skip anyone who
--   already has an upcoming booked class (no need to nudge someone who's
--   already coming back).
--
--   "10 day intro pack não interessa quantas aulas fez, só que estão a
--   terminar nos últimos 5 dias" — drops the old ">5 classes used"
--   requirement entirely; window widened from 3 to 5 days.
--
--   "10 day intro pack: avisar se estiver a usar pouco (por exemplo,
--   passaram 5 dias desde que ativou o pacote - que é a data da primeira
--   aula - e ainda só fizeram 2 aulas)" plus "since it's daily, we can do
--   exactly 5 days, only 1 or 2 classes. each person only appears once."
--   — a brand new early-warning bucket, independent of the ending-soon
--   one: exactly 5 days after the FIRST check-in on this specific pack
--   (not the purchase date, not the lifetime-first-ever visit — see
--   below), if they've only done 1 or 2 classes so far. The exact-day
--   match is what makes "each person only appears once" true for free:
--   with a daily cron, "today - first_pack_visit = 5" is true on exactly
--   one calendar day per person.
--
-- "Activation = date of first check-in" (founder's own definition, also
-- true for class packs elsewhere): verified this is NEITHER
-- v_pulse_intro_purchase.kenko_start (empirically ~= the Kenko ledger/
-- membership start date, close to intro_purchase, not the first actual
-- class — checked live, diverges from the true first visit in most
-- sampled rows) NOR v_pulse_member_activity.first_visit (LIFETIME first
-- visit ever, which can predate this specific pack entirely for someone
-- with prior history). The real per-pack first/last check-in dates come
-- from va.v_pulse_intro_class_visits (per-visit rows, on_pack flags
-- whether that visit falls inside this specific pack's window) — verified
-- live: MIN(day) FILTER (WHERE on_pack) for a real 10-Day buyer matched
-- their actual first class exactly, one day after intro_purchase.
--
-- New `reason` column tells haven-va which of the 4 buckets a row is in,
-- so the message formatter doesn't have to re-derive the qualifying logic
-- (same "the view is the whole decision" principle as the rest of this
-- migration). A 10-Day pack that happens to satisfy both 'ending' and
-- 'underused' in the same run reports 'ending' — the more time-sensitive
-- of the two — this is expected to be rare (the two windows sit at
-- opposite ends of a pack's life) and is a deliberate priority choice,
-- not a bug.
--
-- The "how many days does a completed_followup row stay visible after
-- the 2nd class" window (0-3 days here) is Claude Code's own default —
-- the founder only specified WHEN it starts showing ("aparece no dia
-- seguinte ao pack acabar"), not how long it should keep showing.
-- Adjust the literal `3` below if that's not the right length.
CREATE OR REPLACE VIEW va.v_pulse_intro_pack_watch AS
WITH today AS (
  SELECT CURRENT_DATE AS today
),
converted AS (
  SELECT member_id FROM va.v_pulse_intro_conversion WHERE converted OR converted_pack
),
pack_visit_dates AS (
  SELECT member_id, bought_on, pack_group,
    MIN(day) AS first_pack_visit,
    MAX(day) AS last_pack_visit
  FROM va.v_pulse_intro_class_visits
  WHERE on_pack
  GROUP BY member_id, bought_on, pack_group
)
SELECT
  p.member_id,
  p.email,
  p.pack,
  p.item_name,
  p.intro_end,
  p.visits_in_pack,
  v.first_pack_visit,
  v.last_pack_visit,
  CASE
    WHEN p.pack = '2-Class' AND p.visits_in_pack = 1 THEN 'unused_ending'
    WHEN p.pack = '2-Class' AND p.visits_in_pack = 2 THEN 'completed_followup'
    WHEN p.pack = '10-Day' AND p.intro_end BETWEEN t.today AND t.today + 5 THEN 'ending'
    WHEN p.pack = '10-Day' THEN 'underused'
  END AS reason
FROM va.v_pulse_intro_purchase p
CROSS JOIN today t
LEFT JOIN pack_visit_dates v
  ON v.member_id = p.member_id AND v.bought_on = p.intro_purchase AND v.pack_group = p.pack
WHERE p.pack IN ('2-Class', '10-Day')
  AND NOT p.is_open_day AND NOT p.is_valentine AND NOT p.is_for_members
  AND p.is_activated
  AND p.intro_end >= p.intro_purchase
  AND p.member_id NOT IN (SELECT member_id FROM converted)
  AND (
    -- 2-Class, hasn't used the 2nd class yet, running out of time, and
    -- not already booked for one.
    (p.pack = '2-Class' AND p.visits_in_pack = 1
       AND p.intro_end BETWEEN t.today AND t.today + 5
       AND NOT EXISTS (
         SELECT 1 FROM va.v_pulse_member_activity ma
         WHERE ma.member_id = p.member_id AND ma.next_or_last_booked >= t.today
       ))
    OR
    -- 2-Class, used both classes — conversion follow-up window.
    (p.pack = '2-Class' AND p.visits_in_pack = 2
       AND v.last_pack_visit IS NOT NULL
       AND t.today - v.last_pack_visit BETWEEN 0 AND 3)
    OR
    -- 10-Day, ending within 5 days — usage doesn't matter any more.
    (p.pack = '10-Day' AND p.intro_end BETWEEN t.today AND t.today + 5)
    OR
    -- 10-Day, exactly 5 days since the first check-in on this pack, and
    -- still at 1 or 2 classes — early low-utilization warning.
    (p.pack = '10-Day' AND p.visits_in_pack IN (1, 2)
       AND v.first_pack_visit IS NOT NULL
       AND t.today - v.first_pack_visit = 5)
  );

COMMENT ON VIEW va.v_pulse_intro_pack_watch IS
  'haven-va business rule (not raw Studio Pulse data): activated 2-Class/10-Day intro packs worth a same-day nudge. Four buckets via `reason`: unused_ending (2-Class, 1 of 2 used, <=5 days left, no upcoming booking), completed_followup (2-Class, both used, within 3 days of the 2nd class — for a conversion follow-up, not a reminder), ending (10-Day, <=5 days left regardless of usage), underused (10-Day, exactly 5 days since first check-in on this pack and still at 1-2 classes). Excludes already-converted members and a known Kenko data anomaly (intro_end before intro_purchase). Used by haven-va''s intro-pack-expiring.ts cron, 08:15 daily.';
COMMENT ON COLUMN va.v_pulse_intro_pack_watch.member_id IS 'md5(lower(email)) — join v_pulse_member_identity for name/phone.';
COMMENT ON COLUMN va.v_pulse_intro_pack_watch.email IS 'Carried through from v_pulse_intro_purchase (which already exposes it) so the caller can look up phone without a second member_id-keyed join.';
COMMENT ON COLUMN va.v_pulse_intro_pack_watch.pack IS '2-Class or 10-Day.';
COMMENT ON COLUMN va.v_pulse_intro_pack_watch.item_name IS 'The pack as sold, e.g. "2 Classes | Premium" — for display.';
COMMENT ON COLUMN va.v_pulse_intro_pack_watch.intro_end IS 'Kenko''s real expiry date for this pack.';
COMMENT ON COLUMN va.v_pulse_intro_pack_watch.visits_in_pack IS 'Classes checked in ON this specific pack (not lifetime).';
COMMENT ON COLUMN va.v_pulse_intro_pack_watch.first_pack_visit IS 'Earliest checked-in class day on this specific pack (from v_pulse_intro_class_visits, on_pack only) — "activation" per the founder''s own definition. Null if they haven''t checked in yet.';
COMMENT ON COLUMN va.v_pulse_intro_pack_watch.last_pack_visit IS 'Latest checked-in class day on this specific pack — for 2-Class completed_followup rows, this is the 2nd (final) class date.';
COMMENT ON COLUMN va.v_pulse_intro_pack_watch.reason IS 'Which of the 4 qualifying rules this row matched: unused_ending, completed_followup, ending, underused. See the view comment for each one''s exact rule.';
