# Referidos e convidados — push referrals and guests to an intro pack

`src/crons/referral-guest-leads.ts`, daily 08:18 Europe/Lisbon. Design agreed with Madalena in a grilling session, 2026-10-16.

## Why

People who come through a member rarely buy anything afterwards. On 2026-10-16 there were 77 guests since February: 76 came to the class, 54 on a guest pass, only 9 ever paid and 3 bought an intro pack. There were also 10 referrals "Joined" in Kenko, none with an intro pack. This list is the step **before** "Tracking intro packs".

## Where the rules live

All in the studio view `va.v_pulse_referral_guest_leads`, requested from haven-studio on 2026-10-16 in Haven-Comms `docs/PROMPT-referral-guest-leads-haven-studio.md`. The cron does nothing until the view exists (`viewExists`).

- **Who:** referred with an ambassador's code (`kenko_referrals`), or a guest at a class (`kenko_bookings.booked_by_friend` set; `contact_email` = the guest, `booked_by_friend` = the member). Both = one row, origin `referral`.
- **Never paid before** they entered (`v_pulse_first_paid`).
- **Window:** `entered_on >= 2026-08-17`, the 60-day backfill.
- **`state`:** `bought_intro` / `converted` / `bought_other` / `cold` (30 days, counted to `data_as_of`) / `open`.

`src/lib/referral-guest-leads.ts` (`planReferralGuests`, pure, tested) maps the view onto Notion. Names, email and phone come from `v_pulse_member_identity`.

## Notion "Referidos e convidados" (`NOTION_REFERRAL_GUESTS_DB_ID`)

One row per person, keyed on `Member ID`, never deleted. Schema: `scripts/setup-notion-dbs.mjs --only="Referidos e convidados"`.

- **Bot-written:** Name, Member ID, Origem (Referral / Convidado), Trazida por (the member's name from identity, else Kenko's name), Entrou em, Aulas feitas, Email, Telefone, Estado.
- **Never written by the bot:** Notas, Último contacto.
- **Main view:** Estado A contactar / Contactado / Follow up.

Estado rules:

| View `state` | Estado | Over what |
|---|---|---|
| new + `open` | A contactar (announced) | — |
| new + `cold` (backfill) | Cold lead + a lead | — |
| new + bought anything | not added | — |
| `bought_intro` | Comprou intro pack (they then show in Tracking intro packs) | anything |
| `converted` | Convertido | anything |
| `bought_other` | Comprou outra coisa | anything |
| `cold` | Cold lead + a lead | only A contactar / Contactado |

Perdido never becomes a lead. Follow up never goes cold: only a purchase, or a founder, moves it.

## Cold → "Leads a contactar"

A lead with Canal **"Referral"** or **"Convidado"**, filterable in that DB's views:
- Motivo: "Convidado via X desde AAAA-MM-DD; sem compras 30 dias depois".
- Origem: "Referidos e convidados (cold)".
- Not created when an open lead already exists for the email (`findLeadByEmail`). No message (leads are silent since 2026-10-05).
- `leads-reconcile.ts` archives these on any purchase (`hasRealPurchase`), or when marked Perdido, like any non-Intro-Pack channel.
- The two Canal options are created by Notion on the first write. Don't re-run the setup script on "Leads a contactar" just for them: a declared options list is authoritative and wipes any option the script doesn't know (`notion-api-gotchas.md`).

## Telegram

One group message a day, only when someone joined as A contactar. At most 10 names, then "+N na lista do Notion". It ends with `Fonte: v_pulse_referral_guest_leads` so "porquê?" works. Silent otherwise.

## Safety

- `REFERRAL_GUESTS_DRY_RUN=true` logs the plan and the message; writes and posts nothing.
- An empty view while the list has rows writes nothing.
- A failed create is retried tomorrow and announced then.

## Preview (2026-10-16, rules applied by hand to the raw data, before the view existed)

23 people since 2026-08-17, all guests:
- 17 would be A contactar;
- 5 would be Cold lead and become leads;
- 1 already bought an intro pack and is not added.
