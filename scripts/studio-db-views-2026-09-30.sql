-- SUPERSEDED 2026-09-30, DO NOT APPLY. These three views broke haven-studio's data-model check C6
-- (a va view must be a plain column copy of one public view) and blocked every dashboard release.
-- Their rules now live in haven-studio's canonical views: public.v_pulse_churn_risk (churn signals,
-- same rows) and public.v_pulse_intro_outcome (is_lead, nudge_window). The va names are column copies,
-- defined in haven-studio packages/dashboard/supabase/va-schema-and-role-migration.sql (section 2d);
-- src/lib/pulse-views.ts keeps the flagged rows (and applies the calendar window for the watch list).
-- Kept below as history.
--
-- Three new views in the `va` schema, alongside the existing `v_pulse_*`
-- views, encoding business-rule logic that used to live in haven-va's own
-- TypeScript. Founder's call, 2026-09-30: "quero que uses views e que não
-- estejas sempre computing do 0" — the raw facts already come from
-- v_pulse_* views; these three add the actual "who qualifies" decision on
-- top, the way the haven-studio dashboard's own views do.
--
-- Naming: kept the `v_pulse_` prefix even though these are haven-va's own
-- derived business rules, not Studio Pulse's raw/curated facts — a
-- different prefix would have been more honest about authorship, but
-- haven-va's own "porquê?"/`/flag` machinery (src/lib/pulse-source.ts's
-- extractViewsFromText, src/lib/pulse-views.ts's isPulseView) hardcodes
-- `/^v_pulse_[a-z_]+$/` as a security allowlist in two places. Matching
-- the existing convention means these three views work with that
-- machinery for free; a new prefix would need that regex widened in both
-- places for no real benefit.
--
-- Every view here was verified against live production data before being
-- handed over (read-only spot checks: known real cases like Carla Costa's
-- hand-edited Kenko date, Maria Murteira's cleared payment failure, Darina
-- Sinegubova's upcoming-booking suppression, Raquel Saraiva's excluded
-- utilization signal, and cross-checking the full churn-risk output against
-- the live "Clientes em risco" Notion DB) — see haven-va's PR for this
-- migration for the exact verification queries and results.
--
-- Claude Code (working from haven-va) does NOT have write/DDL access to
-- this database — only a read-only role. Run this migration by hand (or
-- however Studio Pulse's own view migrations get applied) before deploying
-- the haven-va code that reads these views; deploying first will make
-- those three crons fail outright (the views won't exist yet).

-- ============================================================================
-- 1. v_pulse_intro_pack_watch — "expiring soon, still worth a nudge" (replaces
--    src/lib/intro-pack-conversion.ts's findExpiringIntroPacksToWatch).
--
--    Anchored on CURRENT_DATE (the database's own real calendar date), not
--    v_pulse_data_as_of — intro_end is a fixed calendar fact, and the
--    founder confirmed the studio's data won't sync fresh every day, so a
--    forward-looking window anchored on a lagging "as of" date can silently
--    mean "already expired" instead of "coming up" (found in production,
--    2026-09-22). Using the database's own CURRENT_DATE here also means the
--    window is correct the moment this view is queried, with no app-side
--    date math at all.
--
--    Two different windows per pack type, founder's call 2026-09-30:
--    - 2-Class: the real goal is making sure both classes get used, so the
--      nudge should fire with enough runway left to actually book the
--      second class — "this calendar week" (Monday-Sunday), not a flat
--      3-day window.
--    - 10-Day: keeps the tighter 3-day window (it has a hard countdown
--      already, no need for extra runway).
--    Both require exactly the usage pattern worth a same-day nudge: 2-Class
--    with exactly 1 of 2 classes taken, 10-Day with more than 5 taken.
--
--    Data-quality guard: intro_end for 2-Class packs is real Kenko data
--    (not modeled), but genuinely noisy per customer — found a real row
--    where intro_end predates intro_purchase entirely, clearly a bad Kenko
--    record. `intro_end >= intro_purchase` throws those out rather than
--    surfacing a nonsensical "already ended before it started" nudge.
-- ============================================================================
CREATE OR REPLACE VIEW va.v_pulse_intro_pack_watch AS
WITH today AS (
  SELECT CURRENT_DATE AS today
),
converted AS (
  SELECT member_id FROM va.v_pulse_intro_conversion WHERE converted OR converted_pack
)
SELECT
  p.member_id,
  p.email,
  p.pack,
  p.item_name,
  p.intro_end,
  p.visits_in_pack
FROM va.v_pulse_intro_purchase p, today t
WHERE p.pack IN ('2-Class', '10-Day')
  AND NOT p.is_open_day AND NOT p.is_valentine AND NOT p.is_for_members
  AND p.is_activated
  AND p.intro_end >= p.intro_purchase
  AND p.member_id NOT IN (SELECT member_id FROM converted)
  AND (
    (p.pack = '2-Class' AND p.visits_in_pack = 1
       AND p.intro_end >= date_trunc('week', t.today)::date
       AND p.intro_end <  date_trunc('week', t.today)::date + 7)
    OR
    (p.pack = '10-Day' AND p.visits_in_pack > 5
       AND p.intro_end >= t.today AND p.intro_end <= t.today + 3)
  );

COMMENT ON VIEW va.v_pulse_intro_pack_watch IS
  'haven-va business rule (not raw Studio Pulse data): activated 2-Class/10-Day intro packs worth a same-day nudge before they lapse. 2-Class = exactly 1 of 2 classes used, ending this calendar week (real date, not v_pulse_data_as_of). 10-Day = more than 5 classes used, ending within 3 real days. Excludes already-converted members and a known Kenko data anomaly (intro_end before intro_purchase). Used by haven-va''s intro-pack-expiring.ts cron, 08:15 daily.';
COMMENT ON COLUMN va.v_pulse_intro_pack_watch.member_id IS 'md5(lower(email)) — join v_pulse_member_identity for name/phone.';
COMMENT ON COLUMN va.v_pulse_intro_pack_watch.email IS 'Carried through from v_pulse_intro_purchase (which already exposes it) so the caller can look up phone without a second member_id-keyed join.';
COMMENT ON COLUMN va.v_pulse_intro_pack_watch.pack IS '2-Class or 10-Day.';
COMMENT ON COLUMN va.v_pulse_intro_pack_watch.item_name IS 'The pack as sold, e.g. "2 Classes | Premium" — for display.';
COMMENT ON COLUMN va.v_pulse_intro_pack_watch.intro_end IS 'Kenko''s real expiry date for this pack.';
COMMENT ON COLUMN va.v_pulse_intro_pack_watch.visits_in_pack IS 'Classes checked in ON this specific pack (not lifetime).';


-- ============================================================================
-- 2. v_pulse_intro_pack_leads — "expired 21+ days ago, never converted" (replaces
--    src/lib/intro-pack-conversion.ts's findUnconvertedIntroPacks, plus the
--    "first pack per person" dedup from selectFirstTrackedPacks and the
--    digest-recency window from src/crons/leads-intro-pack.ts).
--
--    Day-21 threshold: empirically validated against churned-vs-active
--    members in an earlier haven-va session — nobody in the 10-Day cohort
--    converts between days 17-21, so waiting costs nothing and cuts false
--    outreach for the 2-Class cohort. Kept as a literal in this view since
--    it's a validated constant, not something that should silently drift.
--
--    is_recent: whether this person crossed the 21-day mark within the
--    last ~week (< 28 days total). Founder's call, 2026-09-28: a person who
--    crossed the threshold months ago because this view (or the pipeline
--    behind it) is new shouldn''t flood every digest forever once they
--    have a Notion lead row — the app still creates a lead row for
--    EVERYONE this view returns (nobody drops off the follow-up list), it
--    only uses is_recent to decide whether to re-announce them in the
--    Telegram digest.
--
--    days_since_expiry is computed against v_pulse_data_as_of (not
--    CURRENT_DATE) deliberately, unlike v_pulse_intro_pack_watch above — this is
--    an elapsed-time-since-a-past-event metric, which the rest of this
--    schema's convention anchors on the data date for internal consistency
--    with everything else read alongside it (visits, conversion status),
--    not the forward-looking-deadline case v_pulse_intro_pack_watch handles.
-- ============================================================================
CREATE OR REPLACE VIEW va.v_pulse_intro_pack_leads AS
WITH first_pack AS (
  SELECT DISTINCT ON (p.member_id)
    p.member_id, p.email, p.pack, p.item_name, p.intro_purchase, p.intro_end, p.is_activated, p.visits_in_pack
  FROM va.v_pulse_intro_purchase p
  WHERE p.pack IN ('2-Class', '10-Day')
    AND NOT p.is_open_day AND NOT p.is_valentine AND NOT p.is_for_members
  ORDER BY p.member_id, p.intro_purchase ASC
),
converted AS (
  SELECT member_id FROM va.v_pulse_intro_conversion WHERE converted OR converted_pack
),
asof AS (SELECT data_as_of FROM va.v_pulse_data_as_of)
SELECT
  fp.member_id,
  fp.email,
  fp.pack,
  fp.item_name,
  fp.intro_end,
  fp.visits_in_pack,
  (a.data_as_of - fp.intro_end) AS days_since_expiry,
  ((a.data_as_of - fp.intro_end) < 28) AS is_recent,
  CASE WHEN ma.last_visit > fp.intro_end THEN ma.last_visit ELSE NULL END AS post_expiry_last_visit,
  COALESCE(ma.visit_count, 0) AS lifetime_visit_count
FROM first_pack fp
CROSS JOIN asof a
LEFT JOIN va.v_pulse_member_activity ma ON ma.member_id = fp.member_id
WHERE fp.is_activated
  AND fp.member_id NOT IN (SELECT member_id FROM converted)
  AND (a.data_as_of - fp.intro_end) >= 21;

COMMENT ON VIEW va.v_pulse_intro_pack_leads IS
  'haven-va business rule: this person''s FIRST activated 2-Class/10-Day intro pack ended 21+ days ago (empirically validated threshold) and they never converted to a subscription/real pack since. One row per member, first pack only. is_recent flags whether they crossed the 21-day mark within roughly the last week, for digest-vs-silent-Notion-only decisions. Used by haven-va''s leads-intro-pack.ts cron, 08:20 Mon.';
COMMENT ON COLUMN va.v_pulse_intro_pack_leads.member_id IS 'md5(lower(email)) — join v_pulse_member_identity for name/phone.';
COMMENT ON COLUMN va.v_pulse_intro_pack_leads.email IS 'Carried through from v_pulse_intro_purchase (which already exposes it) so the caller can look up phone without a second member_id-keyed join.';
COMMENT ON COLUMN va.v_pulse_intro_pack_leads.days_since_expiry IS 'Days between v_pulse_data_as_of and intro_end — an elapsed-time metric, anchored on the data date on purpose.';
COMMENT ON COLUMN va.v_pulse_intro_pack_leads.is_recent IS 'True if they crossed the 21-day unconverted mark within the last ~week (days_since_expiry < 28) — the founder only wants fresh crossers re-announced in the Telegram digest, not a growing backlog every run.';
COMMENT ON COLUMN va.v_pulse_intro_pack_leads.post_expiry_last_visit IS 'Last lifetime checked-in class if it happened AFTER intro_end (a paid drop-in return after the pack lapsed) — null otherwise. Distinct from silence, worth saying explicitly in outreach copy.';
COMMENT ON COLUMN va.v_pulse_intro_pack_leads.lifetime_visit_count IS 'Lifetime checked-in classes, any time — for context, not for the qualifying logic.';


-- ============================================================================
-- 3. v_pulse_churn_risk_signals — the 3 empirically-validated churn signals
--    (replaces src/lib/churn-signals.ts's computeChurnFlags/fetchChurnFlags
--    roster + eligibility logic). One row per currently ACTIVE paying
--    member; a member with none of the 3 signals still gets a row, with
--    all three has_* columns false/null, so haven-va can still tell "still
--    active, no current signal" apart from "no longer a member at all"
--    (needed for its own archive-on-resolve/archive-on-churn logic).
--
--    Deliberately does NOT format the pt-PT message text (day counts,
--    month labels like "ago"/"set", percentages) — that stays in haven-va,
--    where it's unit-tested and easy to fix wording without touching this
--    view. This view is the single source of truth for WHO qualifies and
--    the underlying facts; haven-va only renders them.
--
--    Signal 1, "Sem reservas 14+ dias": the stretch to judge starts at the
--    later of member_since or the end of their most recent PAST pause
--    (paused right now = skipped, nothing to judge yet) — a member who
--    paused 27/07-27/08 must not read as having gone quiet the whole time
--    they were paused.
--    Signal 2, "Pagamento falhado": a failed payment in the last 45 days,
--    UNLESS no longer a live concern — the member''s current paying cycle
--    started after the failure (a later payment succeeded), or they have
--    an upcoming booked class (still actively engaged despite what may
--    have just been a small fee charge, not a real subscription failure).
--    Signal 3, "Baixa utilização": under 50% in EACH of the last 3 full
--    calendar months before the data date, counting only months where the
--    member had no pause overlap and a plan with a real allowance (never
--    Unlimited).
-- ============================================================================
CREATE OR REPLACE VIEW va.v_pulse_churn_risk_signals AS
WITH asof AS (
  SELECT data_as_of FROM va.v_pulse_data_as_of
),
roster AS (
  SELECT DISTINCT ON (s.member_id) s.member_id, s.cycle_starts_at AS current_cycle_starts_at,
    s.tier AS current_tier, s.plan AS current_plan
  FROM va.v_pulse_membership_state s, asof a
  WHERE s.is_paying_cycle AND s.cycle_starts_at <= a.data_as_of
    AND (s.cycle_expires_at IS NULL OR s.cycle_expires_at >= a.data_as_of)
  ORDER BY s.member_id, s.cycle_starts_at DESC
),
pause_now AS (
  SELECT DISTINCT member_id FROM va.v_pulse_pause_history WHERE is_current
),
last_past_pause AS (
  SELECT member_id, MAX(cycle_end) AS pause_end
  FROM va.v_pulse_pause_history, asof a
  WHERE cycle_end IS NOT NULL AND cycle_end <= a.data_as_of
  GROUP BY member_id
),
stretch AS (
  SELECT r.member_id, t.member_since,
    GREATEST(t.member_since, COALESCE(lp.pause_end, t.member_since)) AS stretch_start,
    (lp.pause_end IS NOT NULL AND lp.pause_end > t.member_since) AS resumed_from_pause
  FROM roster r
  JOIN va.v_pulse_member_tenure t ON t.member_id = r.member_id
  LEFT JOIN last_past_pause lp ON lp.member_id = r.member_id
  WHERE r.member_id NOT IN (SELECT member_id FROM pause_now)
),
sig_no_booking_raw AS (
  SELECT s.member_id, s.stretch_start, s.resumed_from_pause,
    CASE WHEN ma.next_or_last_booked IS NOT NULL AND ma.next_or_last_booked >= s.stretch_start
         THEN ma.next_or_last_booked ELSE NULL END AS last_in_stretch
  FROM stretch s
  CROSS JOIN asof a
  LEFT JOIN va.v_pulse_member_activity ma ON ma.member_id = s.member_id
  WHERE (a.data_as_of - s.stretch_start) >= 14
),
sig_no_booking AS (
  SELECT member_id, TRUE AS has_no_booking, stretch_start AS no_booking_stretch_start,
    resumed_from_pause AS no_booking_resumed_from_pause, last_in_stretch AS no_booking_last_date,
    (a.data_as_of - COALESCE(last_in_stretch, stretch_start)) AS no_booking_gap_days
  FROM sig_no_booking_raw, asof a
  WHERE (a.data_as_of - COALESCE(last_in_stretch, stretch_start)) > 14
),
sig_failed AS (
  SELECT r.member_id, TRUE AS has_failed_payment, f.last_failed_on AS failed_payment_date
  FROM roster r
  CROSS JOIN asof a
  JOIN va.v_pulse_failed_payments f ON f.member_id = r.member_id AND f.failed_45d > 0
  LEFT JOIN va.v_pulse_member_activity ma ON ma.member_id = r.member_id
  WHERE NOT (r.current_cycle_starts_at > f.last_failed_on)
    AND NOT (ma.next_or_last_booked IS NOT NULL AND ma.next_or_last_booked > a.data_as_of)
),
target_months AS (
  SELECT (date_trunc('month', a.data_as_of) - (n || ' months')::interval)::date AS month
  FROM asof a, generate_series(1, 3) AS n
),
util_ok AS (
  SELECT u.member_id, u.month, u.utilization_pct
  FROM va.v_pulse_utilization_monthly u
  JOIN target_months tm ON tm.month = u.month
  WHERE u.is_full_month AND NOT u.had_pause AND u.allowance IS NOT NULL AND u.utilization_pct IS NOT NULL
),
sig_low_util AS (
  SELECT member_id, TRUE AS has_low_utilization,
    round(avg(utilization_pct), 1) AS low_util_avg_pct,
    jsonb_agg(jsonb_build_object('month', month, 'pct', round(utilization_pct, 1)) ORDER BY month ASC) AS low_util_months
  FROM util_ok
  GROUP BY member_id
  HAVING count(*) = 3 AND bool_and(utilization_pct < 50)
)
SELECT
  r.member_id,
  r.current_tier,
  r.current_plan,
  COALESCE(nb.has_no_booking, FALSE) AS has_no_booking,
  nb.no_booking_gap_days,
  nb.no_booking_last_date,
  nb.no_booking_stretch_start,
  nb.no_booking_resumed_from_pause,
  COALESCE(fp.has_failed_payment, FALSE) AS has_failed_payment,
  fp.failed_payment_date,
  COALESCE(lu.has_low_utilization, FALSE) AS has_low_utilization,
  lu.low_util_avg_pct,
  lu.low_util_months
FROM roster r
LEFT JOIN sig_no_booking nb ON nb.member_id = r.member_id
LEFT JOIN sig_failed fp ON fp.member_id = r.member_id
LEFT JOIN sig_low_util lu ON lu.member_id = r.member_id;

COMMENT ON VIEW va.v_pulse_churn_risk_signals IS
  'haven-va business rule: the 3 empirically-validated churn signals (no booking 14+ days, failed payment in 45 days with resolved-since suppression, low utilization in each of the last 3 full months), one row per currently active paying member (flagged or not, so haven-va can tell "still active, no signal" from "no longer a member"). Deliberately exposes facts, not formatted pt-PT text — haven-va renders the message. Used by haven-va''s churn-risk.ts cron, 08:45 Mon.';
COMMENT ON COLUMN va.v_pulse_churn_risk_signals.member_id IS 'md5(lower(email)) — join v_pulse_member_identity for name/phone. A member_id present here but with all has_* false is still an active member, just with no current signal.';
COMMENT ON COLUMN va.v_pulse_churn_risk_signals.current_tier IS 'Tier of the member''s current live paying cycle (e.g. "4x", "Unlimited") — for display ("Plano" in Notion), not part of the signal logic.';
COMMENT ON COLUMN va.v_pulse_churn_risk_signals.current_plan IS 'Plan of the member''s current live paying cycle (e.g. "Premium") — for display, not part of the signal logic.';
COMMENT ON COLUMN va.v_pulse_churn_risk_signals.has_no_booking IS 'No booked/waitlisted class in the relevant stretch, gap > 14 days.';
COMMENT ON COLUMN va.v_pulse_churn_risk_signals.no_booking_gap_days IS 'Days since the last in-stretch booking, or since the stretch started if none.';
COMMENT ON COLUMN va.v_pulse_churn_risk_signals.no_booking_last_date IS 'The last in-stretch booked/waitlisted class day, if any.';
COMMENT ON COLUMN va.v_pulse_churn_risk_signals.no_booking_stretch_start IS 'Later of member_since or the end of the most recent past pause — the date the "no booking" gap is measured from.';
COMMENT ON COLUMN va.v_pulse_churn_risk_signals.no_booking_resumed_from_pause IS 'True if the stretch start came from a pause ending, not from member_since.';
COMMENT ON COLUMN va.v_pulse_churn_risk_signals.has_failed_payment IS 'A failed payment in the last 45 days, not superseded by a later successful cycle or an upcoming booking.';
COMMENT ON COLUMN va.v_pulse_churn_risk_signals.failed_payment_date IS 'The failed payment date driving has_failed_payment.';
COMMENT ON COLUMN va.v_pulse_churn_risk_signals.has_low_utilization IS 'Under 50% utilization in each of the last 3 full calendar months (no pause overlap, real allowance).';
COMMENT ON COLUMN va.v_pulse_churn_risk_signals.low_util_avg_pct IS 'Average utilization percentage across those 3 months.';
COMMENT ON COLUMN va.v_pulse_churn_risk_signals.low_util_months IS 'jsonb array of {month, pct}, oldest first, for the 3 months behind low_util_avg_pct.';
