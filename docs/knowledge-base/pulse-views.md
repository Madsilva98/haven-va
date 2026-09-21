# Studio numbers: the `v_pulse_*` views

How the bot reads member data since 2026-09-21, why it no longer reads `kenko_*` tables, and how a wrong number gets fixed. Spec and the audit that started it: `docs/plans/2026-09-21-pulse-views-spec.md`.

## Why

On 2026-09-21 the bot's own definitions were checked against real people in Kenko (`select * from v_pulse_known_cases` in the studio project). They were wrong in five places: it read "active" from `kenko_subscriptions` (Esen Sekerkarar counted as active while paused; Andreia taboleiros dropped while cancellation-scheduled but paying), it computed intro-pack expiry as purchase + 10/21 (Carla Costa's hand-edited 10-Day ended 8 Sep, not 1 Sep), it only counted a conversion after the pack expired (Sofia Orellana converted mid-pack), it required `booking_status = 'Booked'` for attendance (Roberta Dias attended a class Kenko also lists under Cancellations), and it carried a 4-entry staff list against the studio's 25. Every one of those rules now lives in one place — the studio's views — and the bot reads them.

**Rule:** studio numbers come only from `v_pulse_*` views. A number that looks wrong becomes a `pulse_cases` row, never a local fix.

## The connection

`STUDIO_DATABASE_URL` — a Postgres connection string for role **`haven_va`** through the Supabase pooler (`src/lib/studio-db.ts`, `pg` Pool, 3 connections; the role allows 5). The role's `search_path` is schema **`va`**, so every query names views unqualified. What it can do is decided in the studio repo, `packages/dashboard/supabase/va-schema-and-role-migration.sql`:

- select on every `va.v_pulse_*` — definer views (owner `postgres`, `security_invoker = off`) mirroring `public.v_pulse_*`, comments included;
- insert on `va.pulse_cases` — a 7-column view (`raised_by, source, view_name, subject, observed, expected, evidence`); `id`, `status`, `resolved_*` are defaults it cannot touch;
- nothing on `public`. `select * from public.kenko_customers` is `permission denied`.

This replaced the service-role supabase-js client: a stolen bot key used to be a full PII dump. The only PII the bot can see is `v_pulse_member_identity`.

Gotchas:
- `ALTER ROLE … SET search_path` applies at **login**. If you test with `set role haven_va` from a `postgres` session, also `set search_path = va`, or the names resolve to `public.*` and fail with "permission denied for materialized view" (cost an hour on 2026-09-21).
- `pg` returns `DATE` columns as JS Dates by default; `studio-db.ts` overrides the parser so they stay `"YYYY-MM-DD"` strings — every comparison in `pulse-views.ts` is a string comparison.
- Pooler in transaction mode: `insert` + `currval('public.pulse_cases_id_seq')` must share a transaction (`withTransaction`), or the two statements may land on different backends.
- Statement timeout is 30s, set on the role.

## Which view answers what

| Question | View | Notes |
|---|---|---|
| Who is a paying member? | `v_pulse_membership_state` | One row per billing cycle. Active = `is_paying_cycle` and the cycle overlaps the **data-as-of** date. `Cancelation scheduled` and `NULL` (pause scheduled) are paying; `Paused`/`Suspended` are not. `activeMembersAsOf` in `pulse-views.ts` is the spec's SQL in code: 75 on the 2026-09-18 snapshot (`test/pulse-views.test.ts`, real rows). |
| Who is paused, since when, last visit | `v_pulse_paused_detail` | `next_charge_on` is the next charge, **not** the return date. |
| Pause history / stretched cycles | `v_pulse_pause_history` | Signal 1's "measure from the end of the pause" and signal 3's `had_pause`. |
| Name, email, phone, birthday | `v_pulse_member_identity` | The one PII view. Staff excluded. |
| Last booked / last visit / visit count | `v_pulse_member_activity` | Attended = `checkin_status = 'Yes'` alone. `next_or_last_booked` includes future bookings (a future booking is engagement); `last_booked` stops at today. |
| Attended per month | `v_pulse_attendance_monthly` | Feeds utilization. |
| Utilization vs plan | `v_pulse_utilization_monthly` | Skip `had_pause` and `in_progress` months; `allowance` NULL = Unlimited. ±1 class of noise; never one month as a verdict. |
| Failed payments | `v_pulse_failed_payments` | `failed_45d` counts from calendar today. A failed payment is a signal, not a suspension. |
| Ever paid? | `v_pulse_first_paid` | Absent = a lead. Replaced `hasRealPurchase`'s two-table count. |
| Intro packs sold, real expiry | `v_pulse_intro_purchase` | `intro_end` = Kenko's ledger expiry when the sale matched a pack (`intro_end_source = 'kenko'`), else modeled. Never compute purchase + 10/21. |
| Converted after an intro | `v_pulse_intro_conversion` | `converted` (membership on/after the purchase, mid-pack counts) or `converted_pack` (a real 5x/10x pack). Either = never chase as a lead. A drop-in is not a conversion. |
| Class packs / intro holders (birthday audience) | `v_pulse_classpack_state`, `v_pulse_intro_holder_state` | Windows keyed by `member_id`. |
| The ledger of wrong numbers | `v_pulse_known_cases` | Open first. Read it before changing any studio definition. |

Two rules every reader follows:
- **Data-as-of, never the calendar.** `computeDataAsOf` = `max(cycle_starts_at) <= today` over `v_pulse_membership_state`. A renewal after the last Kenko import is not a churn (Tatyana Khvesko, case #6). The churn signals are computed as of that date too, and the digest's `Fonte:` line says `dados até dd/mm/aaaa`.
- **`member_id = md5(lower(email))`, no trim.** The views' join key; `memberIdFromEmail` in `pulse-views.ts`. Trim user-entered emails *before* hashing (Notion, /flag); never trim what the views give back.

## Fonte, porquê?, /flag, /casos

- Every digest a cron posts goes through `sendGroupMessageWithSource` (`src/lib/pulse-source.ts`): it appends `Fonte: v_pulse_a, v_pulse_b · dados até …` and remembers the views for that chat.
- **"porquê?"** / "why?" in the group (bare question, or as a reply to a digest) → `handleWhy` (`src/bot/pulse.ts`) answers with `obj_description('va.<view>'::regclass, 'pg_class')` plus every column that has a `col_description`. Live, over the bot's own connection. A view with no comment answers "ainda sem descrição na base de dados" — add the comment on the studio side and re-apply the `va` migration (it copies comments).
- **`/flag <texto>`** → one `pulse_cases` row: `raised_by` = the founder, `source = telegram`, `status = open`, `subject = observed = the text`, `expected = "por confirmar no Kenko"`, `view_name` = the view of the replied-to message or the last one named in the chat. Replies with the id. Mafalda resolves it on the studio side with the rule and the commit.
- **`/casos`** → the open rows of `v_pulse_known_cases`.
- The bot raises cases itself when a question has no view (`raised_by = bot`, `source = session`) — that is how the six views above were requested (cases #15–#19).

## The `kenko_` guard

`test/kenko-guard.test.ts` scans `src/**/*.ts` (comments stripped) for a `kenko_*` table name as a whole string literal and fails on anything not in `src/lib/kenko-allowlist.json` — which is empty and asserted empty. The role could not read those tables anyway; the guard keeps a definition from being smuggled back in as SQL. If a new question has no view: write the `pulse_cases` row, do not add an entry.

## Verifying against the spec

```sql
-- as postgres on the studio project
set role haven_va; set search_path = va;
with asof as (select max(cycle_starts_at) d from v_pulse_membership_state where cycle_starts_at <= current_date)
select (select d from asof), count(distinct member_id)
  from v_pulse_membership_state, asof
 where is_paying_cycle and cycle_starts_at <= asof.d and (cycle_expires_at is null or cycle_expires_at >= asof.d);
-- 2026-09-18, 75 on 2026-09-21. Esen Sekerkarar out, Andreia taboleiros in.
```
The same numbers are pinned in `test/pulse-views.test.ts` on `test/fixtures/v_pulse_membership_state.2026-09-18.json` (hashes only). Refresh the fixture when the roster rule changes, not when the roster does.

## When to update

- A `v_pulse_*` view is added or its rule changes → row in the table above, and the reader in `pulse-views.ts`.
- A case teaches a gotcha the code can't express → here.
- The connection or role changes → "The connection" section and `.env.example`.
