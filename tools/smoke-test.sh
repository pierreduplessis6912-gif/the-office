#!/usr/bin/env bash
# Post-deploy smoke test: is the Worker that is NOW live actually behaving? (SHIP_CHECKLIST.md item 5)
#
# Usage: bash tools/smoke-test.sh https://office.websitehub.co.za
# It asks the live Worker, as a stranger, for things whose answers are known, and fails if any answer is wrong:
#   - /health says ok (retried for a while, because a new version takes a few seconds to go live);
#   - a normal route, a message route and an admin route each refuse a stranger with a JSON 401 (so the sign-in gate, the admin gate and the front door are
#     all in place, and nothing answers with an HTML error page);
#   - the app's CORS header is on those refusals (or the app could not read them).
# It reads and refuses; it never writes anything and needs no secret. Settings: SMOKE_RETRIES (default 8), SMOKE_DELAY seconds (default 8), SMOKE_ORIGIN, and
# FORCE_FAIL=1, which fails on purpose after the real checks (used only by the rollback drill, to prove the automatic rollback works).
set -u
BASE="${1:?usage: smoke-test.sh BASE_URL}"
BASE="${BASE%/}"
RETRIES="${SMOKE_RETRIES:-8}"
DELAY="${SMOKE_DELAY:-8}"
ORIGIN="${SMOKE_ORIGIN:-https://the-office-preview.pages.dev}"
fail=0
say() { echo "smoke: $*"; }
bad() { echo "smoke: FAIL: $*"; fail=1; }

CODE=""; BODY=""; HEADERS=""
fetch() {
  local method="$1" path="$2"; shift 2
  local tmp; tmp="$(mktemp)"
  CODE="$(curl -sS -m 20 -X "$method" -o "$tmp" -D "$tmp.h" -w '%{http_code}' "$@" "$BASE$path" 2>/dev/null)" || CODE="000"
  BODY="$(cat "$tmp" 2>/dev/null)"
  HEADERS="$(tr -d '\r' < "$tmp.h" 2>/dev/null)"
  rm -f "$tmp" "$tmp.h"
}

ok=0
for i in $(seq 1 "$RETRIES"); do
  fetch GET /health
  if [ "$CODE" = "200" ] && echo "$BODY" | grep -q '"status":"ok"'; then ok=1; break; fi
  say "health not ready (attempt $i of $RETRIES, HTTP $CODE); waiting ${DELAY}s"
  sleep "$DELAY"
done
if [ "$ok" = 1 ]; then say "health ok"; else bad "/health did not answer ok after $RETRIES attempts (last HTTP $CODE)"; say "smoke test FAILED"; exit 1; fi

expect_refusal() {   # METHOD PATH WORDS
  fetch "$1" "$2" -H "Origin: $ORIGIN"
  [ "$CODE" = "401" ] || bad "$1 $2 should refuse a stranger with 401, got HTTP $CODE"
  echo "$HEADERS" | grep -qi '^content-type:.*application/json' || bad "$1 $2 should answer JSON"
  echo "$BODY" | grep -q "$3" || bad "$1 $2 should say \"$3\""
  if echo "$BODY" | grep -q '^[[:space:]]*<'; then bad "$1 $2 answered an HTML page"; fi
  echo "$HEADERS" | grep -qi "^access-control-allow-origin: $ORIGIN" || bad "$1 $2 lacks the CORS header for the app's origin"
}
expect_refusal GET /customers 'sign in required'
expect_refusal POST /messages/text 'sign in required'
expect_refusal GET /debug/customers 'unauthorized'

if [ "${FORCE_FAIL:-0}" = "1" ]; then bad "FORCE_FAIL is set: failing on purpose (rollback drill)"; fi
if [ "$fail" = 0 ]; then say "all checks passed"; exit 0; fi
say "smoke test FAILED"
exit 1
