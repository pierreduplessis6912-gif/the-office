#!/usr/bin/env python3
"""Decides what the production restore workflow may do. It WRITES NOTHING and calls nothing: it reads the snapshot list the workflow fetched and the two inputs, and prints a decision.

  action "list"    no snapshot was named: show what exists, change nothing (the default, so a mis-tap restores nothing)
  action "restore" a snapshot was named, it exists, it FINISHED, and the business id was typed exactly: the workflow may restore it
  action "refuse"  anything else (exit status 2): the workflow stops before any write and goes red, with the reasons

Usage: restore-guard.py <list.json> [denylist.json]        Environment: SNAPSHOT, CONFIRM, BUSINESS
Never restores blind: a list that cannot be read is a refusal, in list mode too, and so is a deny list that was given and cannot be read.

The DENY LIST (ops/restore-denylist.json) names snapshots that must never be restored, each with the reason: the guard refuses them even with the right confirmation, and marks them in the list. It exists because a
snapshot can be a perfectly COMPLETE copy of a damaged business (two were, after the failed restore of 2026-10-14). Separately, a snapshot with noticeably fewer rows than the largest complete one gets a WARNING.
"""
import json
import os
import re
import sys

NAME_OK = re.compile(r"[A-Za-z0-9._-]{1,80}")
SHRINK_WARN_BELOW = 0.9   # warn when a snapshot holds under 90% of the rows of the largest complete snapshot


def decide(raw_list, snapshot, confirm, business, denylist=None):
    snapshot = (snapshot or "").strip() if snapshot is not None else ""
    confirm = confirm if confirm is not None else ""
    out = {"action": "refuse", "business": business, "snapshot": snapshot or None, "newestComplete": None, "available": [], "warnings": [], "reasons": []}
    try:
        data = json.loads(raw_list)
        snaps = data["snapshots"]
        if not isinstance(snaps, list) or not all(isinstance(s, dict) and isinstance(s.get("name"), str) for s in snaps):
            raise ValueError("not a list of snapshots")
    except Exception:  # noqa: BLE001
        out["reasons"].append("the snapshot list could not be read (it is not what the backup route returns), so nothing will be restored blind")
        return out
    if denylist is False:
        out["reasons"].append("the deny list could not be read, so nothing will be restored blind")
        return out
    denied = denylist or {}
    out["available"] = [{"name": s["name"], "complete": bool(s.get("complete")), "finishedAt": s.get("finishedAt"), "rows": s.get("rows"), "files": s.get("files"), "denied": denied.get(s["name"])} for s in snaps]
    done = sorted(s["name"] for s in snaps if s.get("complete"))
    out["newestComplete"] = done[-1] if done else None
    if not snapshot:
        out["action"] = "list"
        return out
    if not NAME_OK.fullmatch(snapshot):
        out["reasons"].append("a snapshot name is letters, digits, dots, dashes and underscores only (up to 80)")
    if confirm != business:
        out["reasons"].append(f"to restore, type the business id exactly in the confirm box: {business}")
    if snapshot in denied:
        out["reasons"].append(f"snapshot {snapshot} is on the deny list and will never be restored: {denied[snapshot]}")
    match = next((s for s in snaps if s["name"] == snapshot), None)
    if NAME_OK.fullmatch(snapshot) and match is None:
        out["reasons"].append(f"there is no snapshot called {snapshot}; the list has: " + (", ".join(s["name"] for s in snaps) or "nothing"))
    elif match is not None and not match.get("complete"):
        out["reasons"].append(f"snapshot {snapshot} never finished (it has no manifest), so it cannot be restored")
    if out["reasons"]:
        return out
    out["action"] = "restore"
    if snapshot != out["newestComplete"]:
        out["warnings"].append(f"{snapshot} is NOT the newest complete snapshot ({out['newestComplete']}): everything written after {match.get('finishedAt')} will be lost")
    biggest = max((s["rows"] for s in snaps if s.get("complete") and isinstance(s.get("rows"), int)), default=0)
    if isinstance(match.get("rows"), int) and biggest > 0 and match["rows"] < SHRINK_WARN_BELOW * biggest:
        out["warnings"].append(f"{snapshot} holds {match['rows']} rows and the largest complete snapshot holds {biggest}: restoring it would lose about {round(100 * (1 - match['rows'] / biggest))}% of the rows. Check this is really what you want")
    out["warnings"].append("everything written since this snapshot was taken is replaced; a safety snapshot of the current state is taken first, and the business is unavailable to members for a minute or so")
    return out


def main():
    if len(sys.argv) not in (2, 3):
        sys.exit("usage: restore-guard.py <list.json> [denylist.json]")
    try:
        raw = open(sys.argv[1], encoding="utf-8").read()
    except OSError:
        raw = ""
    denylist = None
    if len(sys.argv) == 3:
        try:
            parsed = json.load(open(sys.argv[2], encoding="utf-8"))["snapshots"]
            denylist = parsed if isinstance(parsed, dict) and all(isinstance(k, str) and isinstance(v, str) and v for k, v in parsed.items()) else False
        except Exception:  # noqa: BLE001
            denylist = False
    result = decide(raw, os.environ.get("SNAPSHOT"), os.environ.get("CONFIRM"), os.environ.get("BUSINESS", ""), denylist)
    print(json.dumps(result, indent=1))
    sys.exit(0 if result["action"] in ("list", "restore") else 2)


if __name__ == "__main__":
    main()
