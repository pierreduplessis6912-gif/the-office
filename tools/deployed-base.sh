#!/usr/bin/env bash
# Which commit is PRODUCTION RUNNING right now? Prints that commit, or NOTHING when it cannot be established.
# Used by the production pipeline (.github/workflows/deploy.yml) to decide whether the Worker, or a migration, changed SINCE WHAT IS ACTUALLY LIVE, rather than since the previous commit on main (which may never have deployed:
# found 2026-10-17, when a commit that failed its tests was followed by a tests-only fix and the deploy was silently skipped). The deploy stamps its commit into the Worker (wrangler deploy --var GIT_SHA) and /health reports it.
# Arguments: the commit being built, and the base URL of the live Worker. For tests, HEALTH_FILE names a file holding what /health would have said (no network).
# It believes the answer only when it is a full 40-character lower-case sha that is an ancestor of (or equal to) the commit being built (git's ancestor check fails for a commit this repository does not have). Anything else (no answer, an old Worker with no commit, a rewritten
# history, a sibling branch, a malformed value) prints nothing, and the caller treats "unknown" as "deploy and rehearse the migrations": when in doubt, do the safe, slower thing.
SHA="$1"; URL="${2:-https://office.websitehub.co.za}"
if [ -n "${HEALTH_FILE:-}" ]; then BODY=$(head -c 100000 "$HEALTH_FILE" 2>/dev/null || true); else BODY=$(curl -fsS --max-time 20 --retry 2 --retry-delay 3 "$URL/health" 2>/dev/null | head -c 100000 || true); fi
COMMIT=$(printf '%s' "$BODY" | python3 -c '
import json, re, sys
try:
    value = json.load(sys.stdin).get("commit")
except Exception:
    value = None
print(value if isinstance(value, str) and re.fullmatch(r"[0-9a-f]{40}", value) else "")
' 2>/dev/null || true)
[ -n "$COMMIT" ] || exit 0
git merge-base --is-ancestor "$COMMIT" "$SHA" 2>/dev/null || exit 0
echo "$COMMIT"
