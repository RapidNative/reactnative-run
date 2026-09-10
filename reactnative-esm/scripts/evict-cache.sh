#!/usr/bin/env bash
# Keep the reactnative-esm on-disk cache under a size cap by deleting the
# least-recently-READ combined dependency bundles first.
#
# Why: the cache has no eviction and grew ~8 GB/day (98 GB -> 110 GB in a day,
# 2026-09-09/10), filling the 150 GB disk twice. A full disk stops the LIVE
# server from writing new entries, and a deploy's npm install fails. Combined
# bundles (bundle-deps-*.js, 20-75 MB each) are >90% of the bytes; everything
# else is tiny. Every entry is regenerable: a deleted bundle is rebuilt on the
# next request (minutes of CPU), so we only ever drop what nobody has read
# recently. Cloudflare and the per-datacenter nginx caches are NOT storage --
# the origin copy is what makes an edge miss cheap -- so this is a bounded
# hot set, not a wipe.
#
# Ordering is by atime (the root fs mounts with relatime, so a read refreshes
# atime at most once a day: coarse but true). Nothing read in the last
# MIN_AGE_DAYS is deleted even if we stay over the cap; that is reported so
# the cap or the disk can be raised instead.
#
# Usage:
#   evict-cache.sh [--dry-run] [--cap-gb N] [--target-gb N] [--min-age-days N]
# Env overrides: ESM_CACHE_DIR, ESM_CACHE_CAP_GB, ESM_CACHE_TARGET_GB, ESM_CACHE_MIN_AGE_DAYS
# Exit 0 always unless the cache dir is missing; output is one line per
# decision so it reads cleanly in a cron log / journal.
set -euo pipefail

CACHE_DIR="${ESM_CACHE_DIR:-/opt/reactnative-run/reactnative-esm/cache}"
CAP_GB="${ESM_CACHE_CAP_GB:-100}"        # evict when the cache exceeds this
TARGET_GB="${ESM_CACHE_TARGET_GB:-85}"   # ...down to this (headroom so it doesn't run every night)
MIN_AGE_DAYS="${ESM_CACHE_MIN_AGE_DAYS:-1}"
DRY_RUN=0

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --cap-gb) CAP_GB="$2"; shift ;;
    --target-gb) TARGET_GB="$2"; shift ;;
    --min-age-days) MIN_AGE_DAYS="$2"; shift ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
  shift
done

[ -d "$CACHE_DIR" ] || { echo "evict-cache: cache dir not found: $CACHE_DIR" >&2; exit 1; }

stamp() { date -u +%Y-%m-%dT%H:%M:%SZ; }
gb() { awk -v b="$1" 'BEGIN { printf "%.1f", b / 1073741824 }'; }
mb() { awk -v b="$1" 'BEGIN { printf "%d", b / 1048576 }'; }

cap_bytes=$(( CAP_GB * 1073741824 ))
target_bytes=$(( TARGET_GB * 1073741824 ))
used_bytes=$(du -sb "$CACHE_DIR" | cut -f1)

echo "$(stamp) evict-cache: cache=$(gb "$used_bytes")G cap=${CAP_GB}G target=${TARGET_GB}G min-age=${MIN_AGE_DAYS}d dry-run=$DRY_RUN"

if [ "$used_bytes" -le "$cap_bytes" ]; then
  echo "$(stamp) evict-cache: under cap, nothing to do"
  exit 0
fi

to_free=$(( used_bytes - target_bytes ))
freed=0
deleted=0
skipped_recent=0

# Candidates: combined bundles only, oldest access first. find -printf gives
# "atime_epoch size path" per line (GNU find; this runs on the Ubuntu origin).
while IFS=' ' read -r atime size path; do
  [ "$freed" -ge "$to_free" ] && break
  age_days=$(( ( $(date +%s) - ${atime%.*} ) / 86400 ))
  if [ "$age_days" -lt "$MIN_AGE_DAYS" ]; then
    skipped_recent=$(( skipped_recent + 1 ))
    continue
  fi
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "$(stamp) evict-cache: would delete $(basename "$path") ($(mb "$size")M, last read ${age_days}d ago)"
  else
    rm -f -- "$path"
  fi
  freed=$(( freed + size ))
  deleted=$(( deleted + 1 ))
done < <(find "$CACHE_DIR" -maxdepth 1 -type f -name 'bundle-deps-*' -printf '%A@ %s %p\n' | sort -n)

verb=deleted; [ "$DRY_RUN" -eq 1 ] && verb="would delete"
echo "$(stamp) evict-cache: $verb $deleted bundles, $(gb "$freed")G (skipped $skipped_recent read within ${MIN_AGE_DAYS}d)"
if [ "$freed" -lt "$to_free" ]; then
  echo "$(stamp) evict-cache: WARNING still $(gb "$(( used_bytes - freed ))")G after eviction; everything else was read within ${MIN_AGE_DAYS}d -- raise the cap or the disk"
fi
