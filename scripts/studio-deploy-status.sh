#!/usr/bin/env bash
# scripts/studio-deploy-status.sh — SessionStart hook (.claude/settings.json).
#
# The studio dashboard (mssaudade/haven) blocks every release when a check fails, and some
# failures are in the bot's schema `va` (the views this bot reads or adds). When the last
# release failed on a va object, print the notice haven-studio's deploy-failure-notice.sh left
# on the commit: which view, why, and what to change. Silent otherwise, or without gh.
set -uo pipefail
command -v gh >/dev/null 2>&1 || exit 0
sha="$(gh api 'repos/mssaudade/haven/actions/workflows/deploy-main.yml/runs?branch=main&per_page=1' \
  --jq '.workflow_runs[0] | select(.conclusion=="failure") | .head_sha' 2>/dev/null)"
[ -n "$sha" ] || exit 0
notice="$(gh api "repos/mssaudade/haven/commits/$sha/comments" \
  --jq '[.[] | select(.body | contains("deploy-failure-notice"))] | last | .body // ""' 2>/dev/null)"
grep -q 'For the bot (haven-va)' <<<"$notice" || exit 0
echo "STUDIO DASHBOARD RELEASE IS BLOCKED BY THE BOT'S SCHEMA (va): nothing pushed to mssaudade/haven goes live until this is fixed from here."
grep -v '^<!--' <<<"$notice" | sed 's/^/  /'
