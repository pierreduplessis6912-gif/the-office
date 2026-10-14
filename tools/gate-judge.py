#!/usr/bin/env python3
"""The staging gate's verdict (SHIP_CHECKLIST.md item 8): after the candidate code is deployed to staging, did every business object apply the real schema steps without losing anything?

Usage: gate-judge.py <results dir> <the newest step number the code should now know> <label>
Reads, for each staging business, <label>-health-<business>.json (the object's health report), <label>-after-<business>.json (its manifest now) and schema-before-<business>.json (its manifest before the
deploy). Writes <label>.json and prints it. A business FAILS if: its health report cannot be read; it has not picked up the new code (it still knows older steps); a step FAILED; a step is still pending; or
any table it had before has fewer rows now (or is gone). The workflow and the tests run THIS file.
"""
import json
import os
import sys

results, expected, label = sys.argv[1], int(sys.argv[2]), sys.argv[3]


def load(name):
    try:
        with open(os.path.join(results, name)) as handle:
            return json.load(handle)
    except Exception:
        return {}


problems, out = [], {"expected_latest_step": expected, "businesses": {}}
for business in ("staging-co", "staging-two"):
    health = load("%s-health-%s.json" % (label, business))
    schema = health.get("schema") if isinstance(health, dict) else None
    schema = schema or {}
    before = {t.get("name"): t.get("count") for t in (load("schema-before-%s.json" % business).get("tables") or [])}
    after = {t.get("name"): t.get("count") for t in (load("%s-after-%s.json" % (label, business)).get("tables") or [])}
    errors = []
    if not schema:
        errors.append("the health report could not be read")
    else:
        if schema.get("latestKnownStep") != expected:
            errors.append("the new code never reached the object (it knows steps up to %s, expected %s)" % (schema.get("latestKnownStep"), expected))
        if schema.get("error"):
            errors.append("a schema step FAILED: %s: %s" % ((schema.get("error") or {}).get("name"), (schema.get("error") or {}).get("message")))
        elif schema.get("pending"):
            errors.append("%d step(s) not applied: %s" % (len(schema["pending"]), ", ".join(schema["pending"])))
    lost = sorted(t for t, n in before.items() if n is not None and (t not in after or (after.get(t) or 0) < n))
    if lost:
        errors.append("rows or tables lost: %s" % ", ".join(lost))
    out["businesses"][business] = {"ok": not errors, "problems": errors, "tables_compared": len(before), "schema": {k: schema.get(k) for k in ("latestKnownStep", "appliedSteps", "pending", "error", "unknownApplied")}}
    problems += ["%s: %s" % (business, e) for e in errors]
out["ok"] = not problems
out["problems"] = problems
with open(os.path.join(results, label + ".json"), "w") as handle:
    json.dump(out, handle)
print(json.dumps(out, indent=1))
