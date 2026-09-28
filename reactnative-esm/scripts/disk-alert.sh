#!/usr/bin/env bash
# Post to Slack when the esm origin's disk is filling up, before (or as soon
# as) new builds start failing with ENOSPC.
#
# Why: 2026-09-22..28 the 150 GB disk sat at 100% for six days -- ~38 GB of
# bun/npm install caches nobody evicted -- and every new /pkg and /bundle-deps
# build returned 500 while already-cached bundles kept serving, so nothing
# looked broken until someone ran a fresh project. evict-cache.sh now caps
# those caches, but it runs once a night and the bundle cache grows ~8 GB/day;
# this is the tripwire for whatever fills the disk next.
#
# Alerts (each level posts once on the way up, and once on recovery):
#   WARN_PCT  (default 85)  disk use at or above -> warning
#   CRIT_PCT  (default 95)  disk use at or above -> critical
#   ENOSPC in the service journal over the last run interval -> critical,
#   re-posted at most once per ENOSPC_REPOST_MIN while it continues.
#
# Config: /etc/reactnative-esm-alert.env (root-only, NOT in git), e.g.
#   SLACK_WEBHOOK_URL=https://hooks.slack.com/services/...
#   WARN_PCT=85
#   CRIT_PCT=95
#
# Usage: disk-alert.sh [--dry-run]   (--dry-run prints the message instead of posting)
# Runs from scripts/reactnative-esm-disk-alert.cron every 5 minutes.
set -euo pipefail

ENV_FILE="${ESM_ALERT_ENV:-/etc/reactnative-esm-alert.env}"
# shellcheck disable=SC1090
[ -f "$ENV_FILE" ] && . "$ENV_FILE"

SLACK_WEBHOOK_URL="${SLACK_WEBHOOK_URL:-}"
WARN_PCT="${WARN_PCT:-85}"
CRIT_PCT="${CRIT_PCT:-95}"
MOUNT="${MOUNT:-/}"
SERVICE="${SERVICE:-reactnative-esm}"
WINDOW_MIN="${WINDOW_MIN:-5}"             # match the cron interval
ENOSPC_REPOST_MIN="${ENOSPC_REPOST_MIN:-60}"
STATE_DIR="${STATE_DIR:-/var/lib/reactnative-esm-alert}"
CACHE_DIR="${ESM_CACHE_DIR:-/opt/reactnative-run/reactnative-esm/cache}"
PM_HOME="${PM_HOME:-/opt/rnesm}"
DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

stamp() { date -u +%Y-%m-%dT%H:%M:%SZ; }
host=$(hostname)

post() {
  local text="$1"
  if [ "$DRY_RUN" -eq 1 ] || [ -z "$SLACK_WEBHOOK_URL" ]; then
    [ -z "$SLACK_WEBHOOK_URL" ] && [ "$DRY_RUN" -eq 0 ] && echo "$(stamp) disk-alert: SLACK_WEBHOOK_URL not set, not posting" >&2
    printf '%s disk-alert: would post:\n%s\n' "$(stamp)" "$text"
    return 0
  fi
  # Slack mrkdwn in a JSON string: escape backslashes, quotes and newlines.
  local json
  json=$(printf '%s' "$text" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | awk 'BEGIN{ORS="\\n"} {print}')
  curl -sS -m 15 -X POST -H 'Content-Type: application/json' \
    --data "{\"text\":\"$json\"}" "$SLACK_WEBHOOK_URL" >/dev/null \
    || echo "$(stamp) disk-alert: Slack post failed" >&2
}

breakdown() {
  local c p
  c=$(du -sh "$CACHE_DIR" 2>/dev/null | cut -f1 || echo "?")
  p=$(du -sh "$PM_HOME" 2>/dev/null | cut -f1 || echo "?")
  printf 'bundle cache: %s | install caches (%s): %s' "$c" "$PM_HOME" "$p"
}

mkdir -p "$STATE_DIR"
level_file="$STATE_DIR/level"
enospc_file="$STATE_DIR/enospc_last"
prev=$(cat "$level_file" 2>/dev/null || echo ok)

read -r size used avail pct < <(df -h --output=size,used,avail,pcent "$MOUNT" | tail -1 | tr -d '%')
level=ok
[ "$pct" -ge "$WARN_PCT" ] && level=warn
[ "$pct" -ge "$CRIT_PCT" ] && level=crit

rank() { case "$1" in ok) echo 0 ;; warn) echo 1 ;; crit) echo 2 ;; esac; }

if [ "$(rank "$level")" -gt "$(rank "$prev")" ]; then
  if [ "$level" = crit ]; then icon=":rotating_light:"; word="CRITICAL"; else icon=":warning:"; word="Warning"; fi
  post "$icon *$word: esm.reactnative.run disk ${pct}% full* (\`$host\`)
${used} of ${size} used, ${avail} free on \`$MOUNT\`. At 100% every new /pkg and /bundle-deps build fails with ENOSPC.
$(breakdown)
Fix: \`reactnative-esm/scripts/evict-cache.sh\` (see reactnative-esm/DEPLOY.md, \"Cache size cap\")."
elif [ "$level" = ok ] && [ "$prev" != ok ]; then
  post ":white_check_mark: *Recovered: esm.reactnative.run disk ${pct}%* (\`$host\`), ${avail} free."
fi
echo "$level" > "$level_file"

# ENOSPC means users are already getting 500s, whatever df says right now.
if command -v journalctl >/dev/null; then
  n=$(journalctl -u "$SERVICE" --since "-${WINDOW_MIN}min" --no-pager 2>/dev/null | grep -c ENOSPC || true)
  if [ "${n:-0}" -gt 0 ]; then
    now=$(date +%s)
    last=$(cat "$enospc_file" 2>/dev/null || echo 0)
    if [ $(( now - last )) -ge $(( ENOSPC_REPOST_MIN * 60 )) ]; then
      post ":rotating_light: *esm.reactnative.run: ${n} ENOSPC errors in the last ${WINDOW_MIN} min* (\`$host\`)
New builds are failing (HTTP 500). Disk ${pct}% (${avail} free).
$(breakdown)"
      echo "$now" > "$enospc_file"
    fi
  fi
fi

echo "$(stamp) disk-alert: disk=${pct}% level=$level (was $prev)"
