# Prompt: haven-studio, churn risk — someone who already cancelled is not "at risk"

Copy the block between the `---` lines into a fresh Claude Code session **in the haven-studio repo**, in its own worktree. Self-contained. Written 2026-10-16 from haven-va after a founder asked why mleopinto@gmail.com, whose membership is cancelled, was still on the "Clientes em risco" list. The bot reads `va.v_pulse_churn_risk_signals` (column copy of `public.v_pulse_churn_risk`) and takes whoever it returns; it holds no rule of its own, so the fix is in the view. Same columns, same names: the bot needs no change.

---

## Mission

`public.v_pulse_churn_risk` is the founders' "who might leave" list (the haven-va bot copies it to Notion "Clientes em risco" every morning). A member who has **already cancelled** is not a risk, the churn has happened. Today such a member stays on the list until the last paid cycle runs out, because the roster only checks `is_paying_cycle` and the cycle dates.

## The real case

`member_id = md5(lower('mleopinto@gmail.com'))` = `539274ff143793b671b360324442bf2c`, Premium 4x. In `v_pulse_membership_state`:

| status | cycle_starts_at | cycle_expires_at | cycle_billing_ends_at | is_paying_cycle | churned_on |
|---|---|---|---|---|---|
| Canceled | 2026-09-08 | 2026-09-09 | 2026-10-08 | true | 2026-09-09 |
| Expired | 2026-09-08 | 2026-10-09 | 2026-10-09 | true | 2026-09-09 |

One class (2026-09-09), nothing booked since. The roster CTE (`is_paying_cycle and cycle_starts_at <= asof and (cycle_expires_at is null or cycle_expires_at >= asof)`) keeps her through the **Expired** row until 2026-10-09, so she was flagged "days without a booking" for a month after cancelling. With `data_as_of` 2026-10-15 she is off the roster now. The rule is still wrong for the next person.

## 1. First, look at the two rows

Same member, same start date, one Canceled (clamped to `churned_on`) and one Expired running to 10-09, both `is_paying_cycle`. Find out in the Kenko import what they really are: one subscription seen twice (cancel event and cycle row), or two subscriptions? Report before changing anything. If it is a duplicate, fix it in `v_pulse_membership_state`, because every view that reads it (birthdays, contact status, ambassadors) inherits it, not only churn.

## 2. The rule

Leave out of `v_pulse_churn_risk` any member whose current membership has a cancellation: status `Canceled`, or `Cancelation scheduled`, or `churned_on` set on the member's latest subscription, even while a paid cycle still runs. Do it in the roster CTE, so every signal and `risk_reasons` follow.

- A **pause** stays as today (the `pauses` / `stretch` handling).
- A **failed payment** stays as today, since that is one of the signals.
- A member who cancelled and **bought a new membership** afterwards is back on the roster through the new cycle.

If `Cancelation scheduled` turns out to be used for something other than a member's own cancellation, stop and report rather than guess.

Update the view comment and the roster comment to say so ("porquê?" in the bot reads them live).

## Packaging

As usual: readable source in `packages/dashboard/supabase/views/`, a dated migration with the header (date, why, rule, after-steps), applied with `scripts/apply-migration.sh`, then `scripts/rebuild-va.sh` so `va.v_pulse_churn_risk_signals` follows. Grants as usual (`security_invoker`, revoke anon/authenticated), `get_advisors('security')`, the speed rule, `data-model-check`, `view-drift --strict`.

## Verification

- Re-run the view for a past `data_as_of` between 2026-09-10 and 2026-10-09 (or with the as-of CTE swapped for that date): `539274ff143793b671b360324442bf2c` is not returned.
- List every member the new rule removes for today's `data_as_of`, with status and `churned_on`. Each one has a cancellation. Paste that list in the PR.
- Members without a cancellation: same rows and the same `risk_reasons` as before.
