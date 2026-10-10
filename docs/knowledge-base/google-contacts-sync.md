# Google Contacts sync

The studio's clients, kept as contacts in the studio's Google account, each with a status label
(Mafalda, 2026-10-10). Cron `src/crons/google-contacts-sync.ts`, 06:30 every day.

## What it does

- **Source:** everyone in `va.v_pulse_member_identity` with a phone number. One contact per phone
  number: when two accounts share a number (the same person with two emails, or a family — 17 numbers
  on 2026-10-10), the account with the best status wins, then the oldest. 590 people with a phone were
  about 570 contacts that day.
- **Phone:** digits only, a leading `00` dropped, `351` in front of a 9-digit number, written `+<digits>`.
- **Labels:** every contact is in `Haven clients` plus exactly one of `Member`, `Class pack`,
  `Former member`, `Idle intro pack`, `Active intro pack`, `Trying to convert`, `Cold lead`, `Lead`.
  The cron creates a missing label.
- **The status rule is a view, not code:** `va.v_pulse_contact_status.status`
  (`scripts/studio-db-contact-status-2026-10-10.sql`, the rule and its data-model review are in that
  file's header). `src/lib/contacts-sync.ts` only knows the eight names.
- **The diff:** the `member_id` is stored inside the contact (clientData `haven_member_id`, invisible in
  Google's UI). Each run reads the `Haven clients` label and compares it with the view: create who is
  new, update a changed name / number / status, remove who is no longer in the view. A contact with no
  `member_id` is matched by phone number — that is how the first run adopts the 574 contacts imported by
  CSV on 2026-10-10, and how a client who changes email (a new `member_id`) keeps the same contact.
- **Never touched:** any contact outside `Haven clients` (they are not even read). On a contact it owns,
  the cron writes the name, the phone, the `member_id` and its own nine labels; other labels and fields
  (notes, email, photo) stay.

## What to know before relying on it

- **A contact put in `Haven clients` by hand is removed on the next run** unless its phone is in the
  view. The label belongs to the bot. Removed contacts sit in Google's bin for 30 days.
- **The bot owns the phone field** of its contacts: a second number added by hand is dropped.
- **The status follows the data date**, not the calendar: after a late Kenko import the labels are as
  old as the import.

## Switching it on

1. **The view.** A haven-studio session applies `scripts/studio-db-contact-status-2026-10-10.sql`
   (the bot's database role is read-only). See `docs/plans/2026-10-10-haven-studio-requests.md`.
2. **Deploy**, then in Madalena's DM: `/authcontacts`. Open the link, **sign in as the studio account**
   (not Madalena's own), paste the `code=` value back. The token goes to
   `DATA_DIR/google-contacts-tokens.json`. It is a different login and file from `/auth`
   (`google-tokens.json`, Madalena's calendar): neither replaces the other.
3. **Dry run first.** Run it by hand with `GOOGLE_CONTACTS_DRY_RUN=true` (below). Madalena gets a DM:
   how many people in the view, how many in the label, how many recognised by phone, and what it would
   create / update / remove. Expect almost everyone recognised by phone and a handful created.
4. **Real run**, by hand or at 06:30. The first success sends one DM with the counts.

```bash
ssh haven-nas "cd /volume1/docker/haven-va/code/haven-va && sudo -n /usr/local/bin/docker compose exec -T -e GOOGLE_CONTACTS_DRY_RUN=true haven-va node -e \"import('./dist/crons/google-contacts-sync.js').then(async m => { await m.run(); process.exit(0); })\""
```

## Health: how a problem shows up

Silent when it works. **Every failed run is a Telegram DM to Madalena** (the group if her ID is not
set), every day until a run succeeds, then one "voltou a funcionar". State and last error:
`DATA_DIR/google-contacts-sync-state.json`. Logs: `cron.google_contacts_sync.plan` / `.done` / `.failed`.

| Message says | Cause | Fix |
|---|---|---|
| "O acesso à conta Google do estúdio expirou ou foi revogado" | Google refused the stored login (`invalid_grant`, 401), or the token file is gone | `/authcontacts` again |
| `relation "v_pulse_contact_status" does not exist` | the view is not applied (or a `va` rebuild lost it) | step 1 above |
| "deu um estado que o bot não conhece" | the view returned NULL or a new label | add the state to the view AND to `STATUS_LABELS` |
| "a etiqueta "Haven clients" não existe ou está vazia" | first run on an account without the import: almost always the wrong Google account | redo `/authcontacts` with the studio account |
| "ia criar N contactos novos de uma vez" / "ia remover N dos M" | more than 25% created (min 25) or 10% removed (min 10) in one run: a phone-format change, a view regression, a bad import | dry run to look; if it is right, one run with `GOOGLE_CONTACTS_FORCE=true` |
| "a vista dos clientes veio vazia" | the view returned nobody with a phone | check the studio DB / the last import |

In every row but the first, nothing is written. Before `/authcontacts` has ever been done the cron only
logs `cron.google_contacts_sync.not_authenticated`: the feature is not on yet, so no alert.

What the alert does **not** cover: the bot process being down (no cron runs at all, so nothing alerts).

## Gotchas

- The People API is eventually consistent: a contact written now may not be in a read for a few minutes.
  Do not run the cron twice in a row and expect the second to see the first one's creates — it may
  create them again. Once a day is safe.
- `GOOGLE_CONTACTS_FORCE` is for ONE run by hand (`-e GOOGLE_CONTACTS_FORCE=true` on the exec). Do not
  put it in the NAS `.env`: it switches every guard off for good.
- Not tested against the live Google account before go-live (no token existed when this was built):
  the dry run in step 3 is the first real read. A name that Google hands back differently from how it
  was written would show as the same contacts in "atualizados" every day — check `updated` in
  `cron.google_contacts_sync.done` over the first few days; it should fall to a handful.
