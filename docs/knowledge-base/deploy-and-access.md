# Deploy and NAS access

The runbook + gotchas catalog for "how do I touch this bot." See [`docs/nas-deploy.md`](../nas-deploy.md) for the canonical step-by-step in pt-PT; this file documents the **lessons not in the runbook**.

## The NAS

- **Hardware**: Synology NAS, hostname `nas-caxias`, located at Madalena's home in Caxias.
- **OS**: DSM (latest available for the box, kernel 4.4.x as of 2026-05).
- **LAN IP**: `192.168.1.11` — works only inside the home network.
- **Tailscale IP**: `100.78.140.59` (MagicDNS: `nas-caxias.tail193734.ts.net`). Use this from anywhere else.

## How to reach the NAS from outside Madalena's home WiFi

Tailscale-only. The NAS has no public IP exposure. Inside `tailscale status`:

| Machine | Owner | Use case |
|---|---|---|
| `nas-caxias` (Linux) | `madalenamqsilva@gmail.com` | The NAS |
| `macbook-air-5` (macOS) | `mafalda.saudade@` | Mafalda's laptop |
| `nena` (Windows) | `madalenamqsilva@gmail.com` | Madalena's laptop (often offline) |

If `tailscale status` says `Tailscale is stopped.`, run `tailscale up`. This bites on every Mac restart — it's the single most common "I can't reach the NAS" failure.

## DSM web UI

**Use HTTPS on port 5001**, not HTTP on 5000. Chrome forces HTTP-to-HTTPS upgrade on plain `:5000` and you get a blank page with no error. Self-signed cert warning is normal — click "Advanced → Proceed" or type `thisisunsafe` on the warning page.

```
https://nas-caxias:5001/
https://100.78.140.59:5001/     ← if MagicDNS isn't working
```

## DSM user accounts — admin matters

There are admin users and non-admin users. Admin users see Container Manager, Package Center, Control Panel in DSM's Main Menu. Non-admin users see only end-user apps (File Station, Drive, Photos, etc.) — they cannot reach Docker logs or DB schemas.

**To debug haven-va you need DSM admin.** Without admin:
- Container Manager isn't visible in Main Menu (or even via the launchApp URL)
- File Station can browse `/volume1/docker/haven-va/` (the user's docker shared folder) but NOT `/volume1/@docker/` (Docker's system path with logs)
- SSH refuses key auth on every common username

**Symptom of being non-admin**: DSM Main Menu shows only File Station, DSM Help, Synology Drive, Synology Photos, Calendar, Contacts, MailPlus Server, PDF Viewer, phpMyAdmin. **No Control Panel, no Package Center, no Container Manager.** Searching "docker" in Main Menu returns "No match found."

If you're stuck like this, ask Madalena to add your DSM user to the `administrators` group (Control Panel → User & Group → your user → tick `administrators`). Log out and back in to refresh the menu.

## Reading container logs

Once you're DSM-admin:

1. DSM Main Menu → **Container Manager**
2. Sidebar → **Container**
3. Double-click `haven-va-haven-va-1`
4. **Log** tab — search box top-right; filters across all entries; pagination shows ~50 lines per page.
5. **General** tab shows env vars in plaintext (don't screenshot/share — see "Secret hygiene" below).

The bot logs structured JSON via `src/lib/log.ts` → `console.log` → stdout → Docker captures. No log file on disk.

Useful searches:
- `error` — should always return 0 results on a healthy bot
- `warn` — should be rare; mostly Notion fallbacks and skipped reminders
- `cron` — confirms cron-registered events at startup (single entry: `server.crons_registered`)
- `pipeline` — shows when pipeline-alerts fired
- `reminders.done` — every 5 min, healthy bot
- `assistant.handled` — assistant processed a user message
- `notion.task_created` — a Notion task was written

## SSH access

Tailscale already gives you network reachability, but you also need:
- Key auth to the right user
- That user's home dir to have `~/.ssh/authorized_keys` with your pubkey
- The user must have **SSH allowed** in DSM (admin group does this by default; non-admin users have to flip a separate switch)

**Current state (2026-05-15)**: Mafalda's pubkey at `~/.ssh/id_ed25519_haven_nas.pub` is **not** installed on the NAS. `ssh haven-nas` exits with `Permission denied (publickey,password)`. To enable, add the pubkey via File Station (with hidden files shown) to `homes/<user>/.ssh/authorized_keys`, permissions 600 on the file and 700 on `.ssh/`.

`~/.ssh/config` alias on Mafalda's Mac:
```
Host haven-nas
  HostName 100.78.140.59
  Port 2604
  User mafalda
  IdentityFile ~/.ssh/id_ed25519_haven_nas
  IdentitiesOnly yes
```

**Tradeoffs of installing the SSH key** are documented in `~/.claude/projects/.../memory/reference_nas_access.md` — short version: persistent root-equivalent access on a machine where the bot's `.env` lives. For pure debug, browser Container Manager is usually enough.

## Filesystem layout (on the NAS)

```
/volume1/
└── docker/
    ├── haven-va/                ← user-visible via File Station
    │   ├── code/
    │   │   └── haven-va/        ← git clone of Madsilva98/haven-va
    │   │       ├── src/
    │   │       ├── dist/        ← built by `npm run build` before `docker compose build`
    │   │       └── …
    │   └── data/                ← mounted as /data in container
    │       ├── .env             ← all env vars, NOT in git
    │       └── google-tokens.json   ← OAuth refresh token, written by /auth flow
    ├── family-bot/              ← Madalena's separate family bot — do not touch
    └── @docker/                 ← Docker's system root, admin-only, has container logs
```

Owner of `/volume1/docker/haven-va/` is `Madalena:users` with `rwxrwxrwx`.

## Deploy

The canonical deploy command per [`CLAUDE.md`](../../CLAUDE.md):

```bash
cd /volume1/docker/haven-va/code/haven-va
git pull
sudo docker compose build --no-cache
sudo docker compose up -d
```

**Run order matters.** `git pull` updates the source; `docker compose build` copies the host's `dist/` into the image (per `Dockerfile`); `docker compose up -d` restarts the container with the new image.

### Gotcha: stale `dist/`

The `Dockerfile` does `COPY dist/ ./dist/` — it does NOT `RUN npm run build`. So if you `git pull` and `docker compose build` without first running `npm run build`, you ship whatever `dist/` was already on disk. **In practice the local clone on the NAS doesn't have node_modules**, so `npm run build` requires `npm install` first.

Fix in flight (planned PR): move `RUN npm ci && npm run build` *inside* the Dockerfile so the build happens during the image build and the host's `dist/` becomes irrelevant.

### Gotcha: `.env` changes don't reload

The compose file uses `env_file: /volume1/docker/haven-va/data/.env`. Compose reads it at container creation, not at runtime. So editing `.env` and running `docker compose restart` does **not** pick up new values — you need `docker compose up -d --force-recreate` (or just rebuild).

### Telegram webhook teardown (one-time)

If migrating from a webhook-based deploy (Vercel etc.):
```bash
curl "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/deleteWebhook"
```
Otherwise Telegram won't deliver to long-polling.

## Rollback

If a deploy goes bad:

```bash
git log --oneline   # find last good commit
git checkout <sha> -- .
sudo docker compose build --no-cache && sudo docker compose up -d
```

Or, faster, redeploy the previous image without rebuilding — but `docker-compose.yml` uses `build:` not `image:`, so there's no image registry to roll back to. Practically: rollback = git checkout + rebuild.

## Secret hygiene

The container's **General** tab in DSM shows every env var in plaintext. **Do not screenshot it. Do not paste env var values into chat.** If a token leaks (incident on 2026-05-15: NOTION_TOKEN for `family-va` was visible in a screenshot during this knowledge-base session), rotate:

- **Notion**: Settings → Integrations → reset integration secret. Update `.env`, recreate container.
- **Telegram**: BotFather → /revoke → new token. Update `.env`, recreate container, run `setWebhook`/`deleteWebhook` as needed.
- **Anthropic**: console.anthropic.com → API Keys → rotate. Update `.env`, recreate container.
- **Google Calendar refresh token**: re-run the `/auth` flow in Madalena's DM with the bot.

## Last touched

2026-05-15 — Seeded from the cost/audit session. Captures the Tailscale + admin-vs-non-admin discoveries.
