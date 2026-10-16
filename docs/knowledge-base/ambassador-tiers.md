# Ambassador tiers — watched on every Kenko import

`src/crons/ambassador-tiers.ts`, daily at 08:25 Europe/Lisbon; acts only when `data_as_of` has moved (a new Kenko import). Design agreed with Madalena in a grilling session on 2026-10-15.

## What the programme is (Madalena, 2026-10-14/15)

A member who refers people gets a discount on their own membership, by how many of the people they referred hold an active membership **on the 1st of the month**:

| Active referred on the 1st | Tier | Discount |
|---|---|---|
| 1 | 1 | 10% (first five ambassadors: 15%) |
| 2–3 | 2 | 15% (first five: 20%) |
| 4–5 | 3 | 50% |
| 6–10 | 4 | 2x por semana oferecida |
| 11+ | 5 | Ilimitado oferecido |

Thresholds changed 2026-10-15. The new tier applies at the ambassador's **next payment**, up or down, no grace month. No stacking with another discount: the larger applies. Any founder applies it in Kenko. Launched 2026-10-15; the **first count is 2026-11-01**. Programme spec: haven-comms `docs/superpowers/specs/2026-10-14-b2b-one-pagers.md`.

**Leaving** = no membership covering the data date: cancelled, or the last cycle expired with no next one. **A pause is not leaving** and **a failed payment is not leaving** (Kenko keeps it Active). "Cancelation scheduled" = about to leave. In Kenko data, "Expired" is mostly the status of every *closed* billing cycle (444 of them on 2026-10-15) — a membership only ended by expiry when no later cycle follows (8 people that day, 1 with a failed payment). There is no "Suspended" in the data.

## Where the rules live

In the studio views, never in the bot:

| View | What the bot takes from it |
|---|---|
| `v_pulse_ambassador_referrals` | who counts today (`excluded_reason` null and `active_on_data_as_of`) |
| `v_pulse_ambassador_tier_monthly` | the tier and label **in force** (latest 1st) and the count on each 1st |
| `v_pulse_ambassador_tier_today` *(requested)* | the tier/label **if the count were today**, `is_first_five`, `discount_in_kenko` |
| `v_pulse_ambassador_tier_scale` *(requested)* | the scale, to answer "if this person leaves, which tier?" |
| `v_pulse_membership_state` | facts only: who has a cancellation scheduled, why someone stopped counting |
| `v_pulse_member_identity` | names |

The two *requested* views, and "a pause still counts", are in Haven-Comms `docs/PROMPT-ambassador-pause-and-discount-haven-studio.md` for a haven-studio session. **Until they land** the bot reads them only if they exist (`viewExists`): no "sobe / desce / mantém" sentence, "Nível / Desconto se fosse hoje" empty, "Em risco" falls back to "fewer people counting than at the last 1st or a cancellation scheduled", and a paused referral stops counting (shown as "saiu … (em pausa)").

Code: `src/lib/ambassador-watch.ts` (snapshot, diff, effects — pure), `src/lib/ambassador-tiers.ts` (the count on the 1st — pure), `src/messages/ambassador-tiers.ts` (text), `src/crons/ambassador-tiers.ts` (orchestration, Notion, state).

## The message (one per import with news; silent otherwise)

```
Embaixadores · dados até 14/11/2026

O que mudou
· Ana Silva: entrou Rita Costa → 4 pessoas. Sobe de 15% para 50% na contagem de 1 de dezembro.
· Joana Reis: Marta Dias agendou o cancelamento → 3 pessoas por agora. Se sair, mantém 15%.
· Sofia Lopes: saiu Eva Matos (cancelou) → 1 pessoa. Desce de 15% para 10% na contagem de 1 de dezembro.

Contagem de 1 de novembro          ← only on the first import covering the 1st
Subiram / Desceram / Novos / Deixam de ter desconto

A fazer
· Avisar Ana Silva: entrou Rita Costa
· Mudar no Kenko, no próximo pagamento: Ana Silva 15% → 50%
```

- Every entry, scheduled cancellation and exit is reported, even when the tier doesn't change (Madalena: tell the ambassador every time).
- The ambassador's own scheduled cancellation or exit is informative only (no "Avisar"), and only when someone counts for them.
- Not addressed to anyone: any founder acts on it.
- Ends with `Fonte: v_pulse_ambassador_referrals[, v_pulse_ambassador_tier_monthly] · dados até …` so "porquê?" and `/flag` work.
- The **first import ever seen is a baseline**: no "entrou" for everyone already counting.

## Notion "Embaixadores" (`NOTION_AMBASSADORS_DB_ID`)

One row per ambassador (everyone in the referrals view), keyed on `Member ID`, refreshed on every import. Schema: `scripts/setup-notion-dbs.mjs` (`node --env-file=.env scripts/setup-notion-dbs.mjs --only=Embaixadores` touches only this DB).

- Bot-written: Name, Member ID, Pessoas ativas hoje, Nível se fosse hoje, Desconto em vigor, Desconto se fosse hoje, Em risco, Pessoas referidas (one line each: "conta", "conta, cancelamento agendado", "em pausa", "cancelou", "ainda sem compra", "não conta: antes do lançamento", …), Atualizado em.
- **Never written by the bot:** Avisada (date, by hand).
- Desconto no Kenko: written by the bot from `v_pulse_ambassador_tier_today.discount_in_kenko` (live since 2026-10-16).
- **Ação no Kenko** (select, bot-written, `kenkoAction` in `src/lib/ambassador-watch.ts`, 2026-10-16) — what to do in Kenko. The main view groups by it and shows everyone:

  | Value | When |
  |---|---|
  | Aplicar | a discount in force, and Kenko has none, a smaller one from elsewhere, or a smaller one from the programme |
  | Baixar | Kenko still has a larger discount from a tier they held before |
  | Retirar | no discount in force, Kenko has one from a tier they held before |
  | Desconto maior | Kenko has a larger discount from elsewhere (no stacking, the larger applies: nothing to do) |
  | Outra origem | no discount in force, Kenko has one they never held as a tier (Luísa Lourenco's 10%, 2026-10-16) |
  | Nada a fazer | Kenko matches, or neither has a discount |

  "From the programme" = the Kenko label equals a label this ambassador held on some 1st. A percentage ranks by its number; an offered membership (2x por semana, Ilimitado) ranks above any percentage.
- "Por aplicar no Kenko" (formula) = Ação is Aplicar / Baixar / Retirar; the view of the same name filters on it. Until 2026-10-16 it was "em vigor ≠ Kenko", which flagged a discount of another origin as work to do.
- The list is refreshed **every day**, also without a new import (no message, no state change), so a discount changed in Kenko shows the next morning once the import carries it.
- Notion failures are logged, never block the message.

## State, alerts, env

- `DATA_DIR/ambassador-tiers-state.json`: last import seen (`lastAsOf`), its snapshot, last month counted. Saved **before** sending: a crash can lose one post, never double it. Delete it to re-baseline (the next import is then silent).
- **"a importação do Kenko ainda não chegou a 1 de …"** — DM to Madalena from the 5th when the data is still short of the 1st. Once per month.
- **"não publiquei nada sobre o import …"** — circuit breaker: over half the people counting leaving in one import (min 4), more than half the tiered ambassadors moving on the 1st (min 4), or no one tiered after a month that had some. Nothing posted or written to Notion, state not advanced. Once per import.
- `AMBASSADOR_TIERS_DRY_RUN=true` — logs `cron.ambassador_tiers.dry_run` (message) and `dry_run_notion` (rows); posts and writes nothing; keeps its own `ambassador-tiers-state.dry-run.json` so successive dry runs show real diffs.
- `AMBASSADOR_TIERS_FORCE=true` — one run past the breaker. Never leave it set.

## Gotchas

- `test/kenko-guard.test.ts` rejects any `kenko_…` inside a string literal in `src/` — that's why the requested column is `discount_in_kenko`, not `kenko_discount`.
- On 2026-10-15 nobody counted yet: 15 ambassadors, 20 referrals, all `before_launch` or `no_purchase` (one — Sónia Silveira → Mafalda Pestana — bought on 2026-10-01, 14 days before launch).

## Out of scope

Applying discounts in Kenko (by hand), the one-off free classes, and any message to the ambassadors themselves — ask Madalena before adding a member-facing message.
