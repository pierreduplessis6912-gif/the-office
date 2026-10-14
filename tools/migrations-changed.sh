#!/usr/bin/env bash
# Did this push change a migration file? Prints "true" or "false". Used by the production pipeline (.github/workflows/deploy.yml) to decide whether the deploy must first pass the staging gate.
# Arguments: the commit the push started from, the commit it ended at, and the event name.
#   - a manual run is never gated (a person asked for exactly that deploy);
#   - when the starting commit is unknown (a first push, a rewritten history) the answer is "true": when in doubt, rehearse.
BEFORE="$1"; SHA="$2"; EVENT="$3"
if [ "$EVENT" = "workflow_dispatch" ]; then echo false; exit 0; fi
if [ -z "$BEFORE" ] || [ "$BEFORE" = "0000000000000000000000000000000000000000" ] || ! git cat-file -e "$BEFORE^{commit}" 2>/dev/null; then echo true; exit 0; fi
if git diff --name-only "$BEFORE" "$SHA" | grep -qE '^worker/migrations/[0-9]{4}_[a-z0-9_]+\.sql$'; then echo true; else echo false; fi
