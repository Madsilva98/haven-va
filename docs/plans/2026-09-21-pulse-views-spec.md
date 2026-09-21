# Spec — the bot reads only `v_pulse_*` views (2026-09-21)

Verbatim from Mafalda, 2026-09-21, plus the decisions taken the same day (bottom).

## Context

The studio Supabase (project `leddqmselxsjamlvxvyk`, the studio MCP `haven-studio-supabase`)
has curated views `v_pulse_*` that are the only source of truth for studio numbers. This bot
currently queries raw `kenko_*` tables with its own definitions, and on 2026-09-21 we checked
the two against real people in Kenko. Read `select * from v_pulse_known_cases` first: every row
is a person where a rule was wrong, what Kenko showed, and the rule that follows. Two rows are
open and are yours to close.

Goal: the bot reads ONLY `v_pulse_*` views, and Madalena can flag a wrong number from Telegram.

1. Inventory every DB query the bot runs (every `.from('kenko_` and every raw SQL string).
   For each, map it to the view that answers it, or say "no view covers this". Post the list
   before changing anything. Known mappings:
   - active member / roster  -> v_pulse_membership_state (is_paying_cycle, is_paused,
     is_unpaid, owes_dues; anchor "today" to the last data date, never the calendar)
   - paused, how long, last visit -> v_pulse_paused_detail; history -> v_pulse_pause_history
   - intro pack holders and expiry -> v_pulse_intro_purchase (intro_end is Kenko's real
     expiry; never compute purchase + 10/21 yourself)
   - converted / converted_pack -> v_pulse_intro_conversion. converted_pack (a real 5x/10x
     pack) counts as converted for messaging: never chase them as a lead. A drop-in is not
     a conversion.
   - attended = checkin_status = 'Yes' alone; do not require booking_status = 'Booked'
     (Roberta Dias, 7 Sep: Kenko lists it under Attended and Cancellations)
   - staff exclusion: none in the bot. The views already exclude staff.
   Every column has a COMMENT in the DB: `list_tables` in the MCP shows them. Trust the
   comment over your reading of the raw table.

2. Replace each raw query with the view read. Where no view covers the question, do NOT
   build the logic here: write the question and the query you would have run into
   `pulse_cases` (status 'open', raised_by 'bot', source 'session', view_name null) and
   stop. Mafalda adds the view on the studio side.

3. Add `/flag` to the Telegram bot: `/flag <texto livre>` inserts a row into `pulse_cases`
   (raised_by 'madalena', source 'telegram', status 'open', subject = the text; view_name if
   the last answer named one). Reply with the row id. Also `/casos` lists open rows.

4. When the bot answers with a number, name the view it came from in one short line, and
   answer "porquê?" / "why?" with that view's COMMENT (pg_description) so Madalena reads
   the rule in words.

5. Guard: a test that fails if any query string in the codebase contains `kenko_` outside
   an allowlist file that must be empty when you finish. Add to CLAUDE.md: "Studio numbers
   come only from v_pulse_* views. A number that looks wrong becomes a pulse_cases row,
   never a local fix."

Verification, all of it before you say done:
- The two open rows in v_pulse_known_cases close with the commit sha in resolved_in.
- Bot's active count = `select count(distinct member_id) from v_pulse_membership_state
  where is_paying_cycle and cycle_starts_at <= <data-as-of> and (cycle_expires_at is null
  or cycle_expires_at >= <data-as-of>)`, with data-as-of = max(cycle_starts_at) <= today.
  Esen Sekerkarar is NOT in it; Andreia taboleiros IS.
- Sofia Orellana is converted, not a lead. Carla Costa's 10-Day ends 8 Sep, not 1 Sep.
- `/flag teste` creates a row you can see in v_pulse_known_cases; delete it after.
- The kenko_ guard test is green with an empty allowlist.
Commits: conventional, atomic, one per step. Do not touch the studio project's schema; if
you need a view that does not exist, that is a pulse_cases row for Mafalda.

## Inventory (step 1, posted 2026-09-21)

| # | Raw read | Used by | View |
|---|---|---|---|
| 1 | `churn-signals.ts:331` subscriptions Active | churn roster | `v_pulse_membership_state` (paying cycle ∩ data-as-of) |
| 2 | `churn-signals.ts:366` memberships Subscription (pause cycles) | churn pause-adjust | `v_pulse_pause_history` |
| 3 | `churn-signals.ts:343` bookings 4mo | signal 1 (no booking 14d) + signal 3 (utilization) | **no view** |
| 4 | `churn-signals.ts:350` payments Failed 45d | signal 2 | **no view** |
| 5 | `intro-pack-conversion.ts:61` memberships intro Expired | intro-pack leads | `v_pulse_intro_purchase` |
| 6 | `:85` subscriptions starts | converted | `v_pulse_intro_conversion.converted` |
| 7 | `:110` memberships non-intro starts | converted | `v_pulse_intro_conversion.converted_pack` |
| 8 | `:141` bookings checkin=Yes (last visit, count) | "voltou depois" text + expiring digest | **no view** |
| 9 | `:316` memberships intro Active expiring ≤3d | expiring digest | `v_pulse_intro_purchase` (`intro_end` in [today, +3]) |
| 10 | `leads.ts:55` customers name/email/phone | phone on leads, fuzzy name | **no view** |
| 11 | `leads.ts:94` payments Paid by email | `hasRealPurchase` | **no view** |
| 12 | `leads.ts:99` sale_items Purchase>0 by email | same | **no view** |
| 13 | `birthdays.ts:40` subscriptions Active | birthday audience | `v_pulse_membership_state` |
| 14 | `birthdays.ts:42` memberships Active credit packs | birthday audience | `v_pulse_classpack_state` + `v_pulse_intro_holder_state` |
| 15 | `birthdays.ts:101` customers DOB | birthdays | **no view** |

## Decisions (Mafalda, 2026-09-21)

- **Ship the views first, nothing goes dark.** Rows 3, 4, 8, 10, 11, 12, 15 stay in the
  `kenko_` allowlist until the 5 views below are live. Then swap them and empty the allowlist.
- **Write the 5 `pulse_cases` rows now** (raised_by `bot`, source `session`, status `open`,
  view_name null) so the gaps are on record:
  1. Identity — `member_id → contact_name, contact_email, contact_phone, date_of_birth`
  2. Attendance per member — `last_visit`, `visit_count`, `last_booked` (checkin=Yes alone)
  3. Failed payments per member, last 45 days
  4. Has-ever-paid per email — first paid order date
  5. Plan utilization per member-month — **in a view, not the bot: one implementation**
- Do steps 3, 4, 5 now (`/flag`, `/casos`, "porquê?", the guard) plus the 8 reads that
  already have a view (rows 1, 2, 5, 6, 7, 9, 13, 14).

## Revision (Mafalda, 2026-09-21, after Task 2)

> Task 3: there is no service key and no PostgREST any more. Read the rule with `select obj_description('va.<view>'::regclass, 'pg_class')` over the bot's own Postgres connection; column rules via `col_description`. All comments are in `va` now. Task 7: the allowlist must be empty, not 7 entries; every raw read has a view (identity, activity, attendance_monthly, failed_payments, first_paid, utilization_monthly). Task 1: the roster query is against `v_pulse_membership_state`, unqualified, on the `haven_va` connection.

Studio side: `packages/dashboard/supabase/va-schema-and-role-migration.sql` — schema `va` with definer-view mirrors of every `public.v_pulse_*` (comments copied), an insert-only `va.pulse_cases`, role `haven_va` (login, `search_path = va`, `statement_timeout = 30s`, connection limit 5, nothing on `public`). The bot's env var is `STUDIO_DATABASE_URL`.

## Facts established while planning (2026-09-21)

- The bot's `STUDIO_SUPABASE_KEY` is the **service_role** key: every `kenko_*` table is
  RLS `service_role only` and the bot reads them in production. So it can read the
  matviews (no anon/authenticated grant) and insert into `pulse_cases` (service_role-only
  policy).
- `member_id` in every view is `md5(lower(contact_email))` (`packages/dashboard/supabase/views/README.md` §2).
  The bot joins view rows to its allowlisted `kenko_customers` read that way until the
  identity view lands.
- PostgREST publishes `COMMENT ON` for tables/views/columns as `description` in the OpenAPI
  document at `GET {STUDIO_SUPABASE_URL}/rest/v1/` (`Accept: application/openapi+json`).
  Supabase's gateway answers that endpoint **only** for the service_role key
  (`"Only the service_role API key can be used for this endpoint"` with anon) — the bot
  has it, so "porquê?" reads live comments with no studio-side change.
- `pulse_cases` NOT NULL: `raised_by, subject, observed, expected`; `status` check
  `open|resolved|wontfix`; `source` default `'mcp'`; `raised_at` default `now()`.
- Live on 2026-09-21: data-as-of = `2026-09-18`, active = **75**; Esen Sekerkarar out,
  Andreia taboleiros in; Sofia Orellana `converted=true` (8x, 2-Class 27 Aug); Carla Costa
  10-Day `intro_end=2026-09-08` source `kenko`.
