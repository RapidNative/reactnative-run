#!/usr/bin/env bash
# Deployment verification for reactnative-esm (see ../DEPLOY.md).
#
#   capture <base-url>   BEFORE upgrading: snapshot hashes of cached web
#                        responses into /tmp/esm-verify-baseline.txt
#   verify  <base-url>   AFTER upgrading: same requests MUST return byte-
#                        identical bodies (the backward-compat guarantee),
#                        plus a fresh web build must still work.
#   native  <base-url>   Exercise the new native surface (?platform=ios,
#                        /prelude) and prove web keys were not disturbed.
#
# Run on the server against 127.0.0.1:5200 so Cloudflare/nginx are out of
# the loop. Exits non-zero on any failure.
set -u
MODE="${1:-}"
BASE="${2:-http://127.0.0.1:5200}"
BASELINE=/tmp/esm-verify-baseline.txt
CACHE_DIR="$(cd "$(dirname "$0")/.." && pwd)/cache"
FAIL=0

say() { printf '%s\n' "$*"; }
die() { say "FAIL: $*"; exit 1; }
check() { # <label> <cond-exit-code>
  if [ "$2" -eq 0 ]; then say "  ok: $1"; else say "  FAIL: $1"; FAIL=1; fi
}

# Sample up to N existing WEB cache keys (no platform suffix), newest first —
# these are the entries real traffic depends on.
sample_keys() {
  ls -t "$CACHE_DIR"/*.js 2>/dev/null \
    | grep -vE '\.(ios|android)\.js$|bundle-deps-|prelude-' \
    | head -8 \
    | while read -r f; do basename "$f" .js; done
}

key_to_url() { # cache key -> /pkg URL (name@version[__subpath])
  local key="$1"
  # "@scope__name@1.2.3__sub__path" -> "@scope/name@1.2.3/sub/path"
  printf '%s' "$key" | sed 's/__/\//g'
}

fetch_hash() { # <url> -> "status sha256"
  local tmp; tmp=$(mktemp)
  local code; code=$(curl -s -o "$tmp" -w '%{http_code}' --max-time 120 "$1")
  local sha; sha=$(shasum -a 256 "$tmp" 2>/dev/null | cut -d' ' -f1 || sha256sum "$tmp" | cut -d' ' -f1)
  rm -f "$tmp"
  printf '%s %s' "$code" "$sha"
}

case "$MODE" in
capture)
  say "Capturing web baseline from $BASE"
  : > "$BASELINE"
  for key in $(sample_keys); do
    url="$BASE/pkg/$(key_to_url "$key")"
    result=$(fetch_hash "$url")
    say "  $key -> $result"
    printf '%s\t%s\t%s\n' "$key" "$url" "$result" >> "$BASELINE"
  done
  # One cached bundle-deps entry, if present
  bd=$(ls -t "$CACHE_DIR"/bundle-deps-*.js 2>/dev/null | head -1)
  if [ -n "${bd:-}" ]; then
    h=$(basename "$bd" .js | sed 's/bundle-deps-//')
    result=$(fetch_hash "$BASE/bundle-deps/$h")
    say "  bundle-deps-$h -> $result"
    printf 'bundle-deps\t%s\t%s\n' "$BASE/bundle-deps/$h" "$result" >> "$BASELINE"
  fi
  [ -s "$BASELINE" ] || die "no cache entries sampled — is CACHE_DIR right? ($CACHE_DIR)"
  say "Baseline written to $BASELINE ($(wc -l < "$BASELINE") entries)"
  ;;

verify)
  [ -s "$BASELINE" ] || die "no baseline found — run 'capture' before upgrading"
  say "Verifying web responses are byte-identical to the pre-deploy baseline"
  while IFS=$'\t' read -r key url expected; do
    actual=$(fetch_hash "$url")
    [ "$actual" = "$expected" ]; check "$key byte-identical" $?
  done < "$BASELINE"

  say "Verifying a FRESH web build still works (uncached tiny package)"
  body=$(curl -s --max-time 300 "$BASE/pkg/left-pad@1.3.0")
  printf '%s' "$body" | grep -q "module.exports"; check "fresh /pkg build returns a module" $?

  say "Verifying X-Externals header still exposed"
  curl -sI --max-time 60 "$BASE/pkg/left-pad@1.3.0" | grep -qi "x-externals"; check "X-Externals header" $?

  [ "$FAIL" -eq 0 ] && say "WEB VERIFICATION PASSED" || die "web verification failed — do NOT purge Cloudflare; consider rollback"
  ;;

native)
  say "Exercising the native surface on $BASE"
  body=$(curl -s --max-time 600 "$BASE/pkg/expo-status-bar@3.0.8?platform=ios")
  printf '%s' "$body" | grep -q "NativeStatusBarWrapper"; check "ios build uses native implementation" $?
  printf '%s' "$body" | grep -q "rapidnative-preview"; [ $? -ne 0 ]; check "ios build has NO web preview shim" $?
  ls "$CACHE_DIR"/expo-status-bar@3.0.8.ios.js >/dev/null 2>&1; check "ios cache key namespaced (.ios.js)" $?

  say "Web key untouched by the native request"
  test -f "$CACHE_DIR/expo-status-bar@3.0.8.js"; check "web cache file still present" $?

  prelude=$(curl -s --max-time 600 "$BASE/prelude/0.81.4")
  printf '%s' "$prelude" | grep -q "__accept"; check "/prelude serves metro-runtime hot machinery" $?
  printf '%s' "$prelude" | grep -qE "\bclass\s"; [ $? -ne 0 ]; check "prelude is Hermes-lowered (no class syntax)" $?

  say "codegenNativeComponent view configs (New Arch; NATIVE_DEPS_VERSION 4)"
  # react-native-screens' NativeComponent specs must compile to a static JS
  # view config, or every expo-router Stack redboxes on bridgeless with
  # "View config not found for component RNSScreenContentWrapper".
  rns=$(curl -s --max-time 600 "$BASE/pkg/react-native-screens@4.26.0?platform=ios")
  printf '%s' "$rns" | grep -q "RNSScreenContentWrapper"; check "ios screens bundle references RNSScreenContentWrapper" $?
  printf '%s' "$rns" | grep -q "__INTERNAL_VIEW_CONFIG"; check "screens specs emit __INTERNAL_VIEW_CONFIG (codegen ran)" $?
  printf '%s' "$rns" | grep -qE "codegenNativeComponent\("; [ $? -ne 0 ]; check "no raw codegenNativeComponent() call survives" $?

  [ "$FAIL" -eq 0 ] && say "NATIVE VERIFICATION PASSED" || die "native verification failed"
  ;;

*)
  die "usage: $0 capture|verify|native [base-url]"
  ;;
esac
exit "$FAIL"
