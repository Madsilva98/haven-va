# Ambassador tiers — the monthly tier-change post

`src/crons/ambassador-tiers.ts`, daily at 08:25 Europe/Lisbon, posts **at most once a month**.

## What the programme is (Madalena, 2026-10-14/15)

A member who refers people gets a discount on their own membership, by how many of the people they referred hold an active membership **on the 1st of the month**:

| Active referred on the 1st | Tier | Discount |
|---|---|---|
| 1 | 1 | 10% (first five ambassadors: 15%) |
| 2–3 | 2 | 15% (first five: 20%) |
| 4–5 | 3 | 50% |
| 6–10 | 4 | 2x por semana oferecida |
| 11+ | 5 | Ilimitado oferecido |

Thresholds changed 2026-10-15. The new tier applies at the ambassador's **next payment**, up or down, no grace month. It does not stack with any other discount: Bia applies the larger. Launched 2026-10-15; the **first count is 2026-11-01**, where everyone with a tier shows as new. Decisions: haven-comms `docs/superpowers/specs/2026-10-14-b2b-one-pagers.md`.

## Where the rules live

All of it in haven-studio's `va.v_pulse_ambassador_tier_monthly` (one row per ambassador per 1st: `tier`, `discount_label`, `active_referred`, `ambassador_is_member`, `is_first_five`, `referred_member_ids`) and `va.v_pulse_ambassador_referrals` (one row per referral). The bot never maps counts to tiers or tiers to labels:

- `src/lib/pulse-views.ts` — `fetchAmbassadorTierMonthly(month)`, `fetchAmbassadorReferrals()`.
- `src/lib/ambassador-tiers.ts` — `planAmbassadorTierChanges(thisMonth, lastMonth, earlier)`, pure: `up` / `down` (tier changed), `new` (first month ever with tier ≥ 1 — back after a month at 0 is `up`), `left` (tier ≥ 1 → 0, or missing from the view; `isMember: false` = the ambassador no longer has a membership). `suspiciousReason` is the breaker.
- `src/messages/ambassador-tiers.ts` — the pt-PT text. Names only from `v_pulse_member_identity`.

An ambassador who isn't a member on the 1st has `tier = 0` in the view even with referrals — the discount has nothing to apply to.

## When it posts

Each morning:

1. Skip if `DATA_DIR/ambassador-tiers-state.json` already has this calendar month as `lastPostedMonth`.
2. Wait until `data_as_of` ≥ the 1st of the month (the Kenko import is manual, so this can be days late). The view has no row for the month before that anyway.
3. Diff this 1st against the previous 1st. Nothing changed → silent, month marked done.
4. Otherwise save the month, **then** post with `sendGroupMessageWithSource(…, ["v_pulse_ambassador_tier_monthly"], asOf)`, so "porquê?" and `/flag` work. A crash between the two can lose one post (re-run by clearing the state file), never double it.

## Alerts (DM to Madalena, group if her ID isn't set)

- **"a importação do Kenko ainda não chegou a 1 de …"** — from the 5th, data still short of the 1st. Once per month. Do the Kenko import; the post goes out the next morning.
- **"não publiquei a contagem de …"** — the circuit breaker: more than half the tiered ambassadors (min 4) moving in one month, or no one tiered when the previous month had some. Once per month. Check with `AMBASSADOR_TIERS_DRY_RUN=true`; if the count is real, run once with `AMBASSADOR_TIERS_FORCE=true`. It never trips on the first count.

## Env

- `AMBASSADOR_TIERS_DRY_RUN=true` — logs `cron.ambassador_tiers.dry_run` with the message; posts and saves nothing.
- `AMBASSADOR_TIERS_FORCE=true` — one run past the breaker. Never leave it set.

## Out of scope

Applying discounts in Kenko (Bia, by hand), the one-off free classes, and any message to the ambassadors themselves — ask Madalena before adding a member-facing message.
