# Requests for haven-studio — intro pack tracking (2026-10-02)

From haven-va PR #51 ("Tracking intro packs"). haven-va's database role is read-only, so these need a
haven-studio session (data-model-review, migration, view file, va rebuild). Do them in this order.

## 1. When a 2-Class intro pack ends — one rule, everywhere

Founder (Madalena, 2026-10-02, verbatim): "the end of the pack, on the 2 day intro pack, IS the day of the
last [class]. this rule applies ALWAYS. if the 2nd class doesn't exist, then yes the pack has an expiry date
(2 weeks after the first class)".

So for a 2-Class pack:
- 2nd class done → the pack ends on the 2nd class.
- otherwise (1 class or none) → the pack ends on its expiry (Kenko's `intro_end`).
- any other pack → expiry (unchanged).

Two places in `public.v_pulse_intro_outcome` disagree today:

a. **`pack_ended_on`** — currently "the 2nd charged to it, else the 1st, none = expiry". The "else the 1st"
   branch contradicts the rule: with 1 class used it must be the expiry. Change
   `coalesce(p.second_class_on, p.first_class_on, p.intro_end)` to `coalesce(p.second_class_on, p.intro_end)`
   (and the same in `month_ended`, `outcome`'s maturing test and `counted`). This moves the conversion
   charts' "ended" basis for 1-class packs — predict the month counts before applying, as the 2026-10-01
   migration did.

b. **`is_lead`** — currently `s.asof - o.ended_on >= 21` (expiry). It must count from the pack end:
   `s.asof - o.pack_ended_on >= 21`. Effect: someone who used both classes quickly reaches "Leads a
   contactar" up to ~2 weeks earlier, right after leaving the bot's tracking list (Cold lead at 20 days
   from the same end) instead of falling into a gap on neither list. `days_since_expiry` / `is_recent`
   (the bot's digest gate) should follow the same end.

## 2. `booked_ahead` on `public.v_pulse_member_activity`

Number of classes the person has booked (status Booked — not cancelled, not waitlist) on a day after
`v_pulse_data_as_of`. The bot shows it in Notion ("Aulas marcadas") and uses it for two rules (a 2-Class
with 1 class and nothing booked is "Pack ending"; an unstarted pack with nothing booked goes idle). Only
`kenko_bookings` has it per person.

## 3. Apply the bot's view

Run haven-va `scripts/studio-db-intro-pack-tracking-2026-10-02.sql` after the va rebuild that carries
`booked_ahead`. It reads only va copies (C6: bot analysis view; saved in `public.va_bot_views`).
Once 1a is live, its own `ended_on` expression can become just `o.pack_ended_on` — same result.

Then tell the founder, who sets `NOTION_INTRO_TRACKING_DB_ID` on the NAS.
