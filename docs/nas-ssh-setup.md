# NAS SSH setup for self-service deploys

## Goal

Let Mafalda deploy `haven-va` to the NAS (`nas-caxias`, `100.78.140.59`) without needing Madalena to do it. The end state is a one-command `npm run deploy:nas` from Mafalda's laptop.

This doc captures the setup state as of **2026-05-15** so any agent (Mafalda's Claude or Madalena's Claude) can resume.

---

## What's done

- [x] Mafalda added to `administrators` group in DSM (Madalena, 2026-05-15)
- [x] DSM → Control Panel → User & Group → Advanced → **User Home service enabled**
- [x] Docker Desktop installed on Mafalda's Mac (`docker --version` → 29.4.3)
- [x] Mafalda's public key copied to `/var/services/homes/mafalda/.ssh/authorized_keys` via `ssh-copy-id` (key fingerprint: `SHA256:EGsEDxSyACIEPqMqpKGn/cMGvh+oxMWo598GH4zMpHc`)
- [x] SSH service enabled in DSM on port 2604

## What's blocking

**SSH key auth from Mafalda's laptop fails with `Permission denied (publickey,password)`** even though the key file exists.

Root cause: Synology's `sshd` enforces `StrictModes` — it silently rejects the key when the home folder, `.ssh` folder, or `authorized_keys` file have group-or-world-write permissions. Synology creates home folders with `users` group write access by default, which trips this check.

Verbose SSH output confirmed the diagnosis: the laptop offers the correct key, but the server replies "publickey" rejected without giving a reason (classic StrictModes behavior — no log line either, by design).

Attempted self-service fix (failed): A DSM Task Scheduler script tried to chmod the paths, but exited with code 2. Output logging wasn't enabled at the time, so the failing line is unknown. Most likely the path `/var/services/homes/mafalda` differs from what was assumed, or the `mafalda:users` chown ran before chmod and changed something the next step couldn't access.

## The fix (Madalena, 30 seconds)

SSH into the NAS as yourself (or any admin who already has working SSH) and run:

```bash
sudo chmod 700 /var/services/homes/mafalda
sudo chmod 700 /var/services/homes/mafalda/.ssh
sudo chmod 600 /var/services/homes/mafalda/.ssh/authorized_keys
sudo chown -R mafalda:users /var/services/homes/mafalda
```

Then add passwordless sudo for `docker` so Mafalda's deploy script doesn't hang on a password prompt:

```bash
echo 'mafalda ALL=(ALL) NOPASSWD: /usr/local/bin/docker' | sudo tee /etc/sudoers.d/mafalda-docker
sudo chmod 440 /etc/sudoers.d/mafalda-docker
sudo visudo -c   # verify syntax — should print "/etc/sudoers: parsed OK"
```

## Verification (run from Mafalda's laptop)

```bash
# 1. Tailscale up
tailscale status | head -3   # should list nas-caxias

# 2. Key auth works
ssh haven-nas "id"
# expected: uid=1027(mafalda) gid=100(users) groups=100(users),101(administrators)

# 3. Passwordless sudo docker works
ssh haven-nas "sudo -n docker ps --format '{{.Names}}'"
# expected: haven-va-haven-va-1   (no password prompt)
```

If all three return the expected output, deploy capability is unblocked.

---

## How `haven-va` is currently deployed (Madalena's manual process)

Source: [`docs/nas-deploy.md`](nas-deploy.md). Summary:

1. Build TS + Docker image **locally** (`npm run build` → `docker build` → `docker save -o haven-va.tar`)
2. Copy tarball to NAS (File Station or SCP)
3. On NAS: `sudo docker load -i haven-va.tar`
4. On NAS: `sudo docker stop && rm` the old container, then `sudo docker run -d ...` with the long flag set (env-file, two `-v` mounts, restart policy)

The critical detail in step 4 is `-v /volume1/docker/haven-va/prompts:/app/dist/prompts` — without this mount, prompt files baked into the image are used and edits to `/volume1/docker/haven-va/prompts/` are ignored.

The repo also has a `docker-compose.yml` but it is **incomplete** — missing the prompts volume mount — so don't use it as-is. Either fix compose or stick with `docker run` to match Madalena's documented command exactly.

---

## Next step (after the fix lands)

Write `scripts/deploy-nas.sh` invoked by `npm run deploy:nas` that automates Madalena's 7-step process end-to-end:

1. `npm run build`
2. `docker build -t haven-va-haven-va .`
3. `docker save haven-va-haven-va -o /tmp/haven-va.tar`
4. `scp /tmp/haven-va.tar haven-nas:/tmp/haven-va.tar`
5. `scp dist/prompts/*.md haven-nas:/volume1/docker/haven-va/prompts/` (sync any prompt edits)
6. `ssh haven-nas "sudo docker load -i /tmp/haven-va.tar"`
7. `ssh haven-nas` to stop, remove, and `docker run` the new container with the exact flags from `docs/nas-deploy.md`
8. Verify: `ssh haven-nas "sudo docker ps --filter name=haven-va-haven-va-1 --format '{{.Status}}'"` and tail 30 lines of logs back to the developer's terminal
9. Cleanup `/tmp/haven-va.tar` on both ends

---

## Debugging guide for future agents

If `ssh haven-nas` fails after the fix above:

| Symptom | Likely cause | Check |
|---|---|---|
| `Permission denied (publickey,password)` | Key not installed, or StrictModes rejection | Re-run the four `chmod`/`chown` lines above |
| `Permission denied, please try again` (password prompt loops) | Auto Block engaged | DSM → Control Panel → Security → Protection → Auto Block → Allow/Block List → remove tailnet IP |
| `Connection closed by … port 2604` | `MaxAuthTries` hit during the same connection, or SSH service paused mid-handshake | Toggle SSH off then on in Control Panel → Terminal & SNMP → Terminal |
| `ssh: connect to host … port 2604: Operation timed out` | Tailscale stopped on laptop | `tailscale up` then `tailscale status` |
| `Connection refused` | SSH service disabled in DSM | Control Panel → Terminal & SNMP → tick **Enable SSH service** |
| `sudo: a password is required` | Sudoers file missing or wrong | Re-run the `tee /etc/sudoers.d/mafalda-docker` step, verify with `sudo visudo -c` |

**Useful logs:**
- DSM Log Center → Logs → System → filter "ssh" — shows auth failures with reasons
- DSM Task Scheduler → Settings → tick "Save output results" before running any user-defined script so you can read the failure output

**Don't waste time on:**
- The `mafalda` username casing — it's lowercase on the NAS
- The Tailscale email mismatch (`mafalda.saudade@` vs `madalenamqsilva@`) — irrelevant, Tailscale only routes packets, SSH does its own auth
- DSM File Station perm edits — Synology File Station uses ACLs, not POSIX modes, so it doesn't reliably fix StrictModes failures
- DSM Web Console — not built into DSM 7, would require installing an extra package

---

## Memory references (for Mafalda's Claude)

- `~/.claude/projects/-Users-mafaldasaudade-The-Haven/memory/reference_nas_access.md` — Tailscale + DSM access
- `~/.claude/projects/-Users-mafaldasaudade-The-Haven/memory/project_haven_va.md` — what the bot does and where it lives

After the fix lands, update both files to mark the SSH/sudo state as working.
