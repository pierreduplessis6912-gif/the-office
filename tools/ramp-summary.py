#!/usr/bin/env python3
"""Summarises one run of the staging memory ramp (staging.yml, mode ramp) into the JSON that is committed as ops/staging-ramp-last.json.

Reads ramp-log.tsv (name, HTTP status, seconds, curl exit; one line per call, written by the workflow) and the response files beside it, and writes ONLY sizes, HTTP statuses, seconds, whether each snapshot and restore reported ok, and
a short excerpt of an error body. No secret is ever in those files (the calls carry the admin keys in request headers, which are never written here). A failure at some size is a RESULT of the ramp, not a failure of this script.
Usage: ramp-summary.py RESULTS_DIR COMMIT
"""
import json, os, re, sys


def read(path):
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            return f.read()
    except OSError:
        return ""


def parse_json(text):
    try:
        return json.loads(text)
    except (ValueError, TypeError):
        return None


def excerpt(text, n=240):
    return re.sub(r"\s+", " ", text).strip()[:n]


def main(results, commit):
    calls = {}
    for line in read(os.path.join(results, "ramp-log.tsv")).splitlines():
        parts = line.split("\t")
        if len(parts) < 4:
            continue
        name, http, seconds, curl_exit = parts[0], parts[1], parts[2], parts[3]
        try:
            calls[name] = {"http": int(http), "seconds": round(float(seconds), 1), "curl_exit": int(curl_exit)}
        except ValueError:
            calls[name] = {"http": None, "seconds": None, "curl_exit": None}

    sizes = sorted({int(m.group(1)) for n in calls for m in [re.match(r"ramp-(\d+)$", n)] if m})
    steps = []
    last_ok = 0
    first_failure = None
    for n in sizes:
        ramp = calls.get(f"ramp-{n}", {})
        snap = calls.get(f"snapshot-{n}", {})
        rest = calls.get(f"restore-{n}", {})
        rampj = parse_json(read(os.path.join(results, f"ramp-{n}.json"))) or {}
        snapj = parse_json(read(os.path.join(results, f"snapshot-{n}.json"))) or {}
        restj = parse_json(read(os.path.join(results, f"restore-{n}.json"))) or {}
        healthj = parse_json(read(os.path.join(results, f"health-{n}.json"))) or {}
        schema = healthj.get("schema") or {}
        snap_ok = snap.get("http") == 200 and bool(snapj.get("snapshot"))
        rest_ok = rest.get("http") == 200 and restj.get("ok") is True and not restj.get("differences")
        step = {
            "rows_requested": n,
            "marker_rows": rampj.get("rampRows"),
            "marker_bytes": rampj.get("rampBytes"),
            "ramp_http": ramp.get("http"),
            "snapshot": {"http": snap.get("http"), "seconds": snap.get("seconds"), "ok": snap_ok, "tables": snapj.get("tables"), "rows": snapj.get("rows")},
            "restore": {"http": rest.get("http"), "seconds": rest.get("seconds"), "ok": rest_ok, "tables_restored": restj.get("tablesRestored"), "rows_restored": restj.get("rowsRestored"), "differences": restj.get("differences")},
            "health_http": calls.get(f"health-{n}", {}).get("http"),
            "schema_clean_after": (schema.get("pending") == [] and schema.get("error") is None) if schema else None,
        }
        if not snap_ok:
            step["snapshot"]["error_excerpt"] = excerpt(read(os.path.join(results, f"snapshot-{n}.json")))
        if not rest_ok and rest:
            step["restore"]["error_excerpt"] = excerpt(read(os.path.join(results, f"restore-{n}.json")))
        steps.append(step)
        if snap_ok and rest_ok and ramp.get("http") == 200:
            last_ok = n
        elif first_failure is None:
            first_failure = n

    clear = calls.get("clear", {})
    cleared = parse_json(read(os.path.join(results, "ramp-clear.json"))) or {}
    final_health = parse_json(read(os.path.join(results, "ramp-final-health.json"))) or {}
    final_schema = final_health.get("schema") or {}
    summary = {
        "commit": commit,
        "business": "staging-two",
        "table": "captures (marker rows, source = 'ramp', about 110 bytes each)",
        "limit_note": "A Durable Object's memory limit is 128 MB; a local proxy suggested restore peaks at roughly 6 to 7 times the largest table's JSON.",
        "steps": steps,
        "largest_size_snapshotted_and_restored_ok": last_ok,
        "first_failure_at_rows": first_failure,
        "ramp_completed_all_sizes": bool(sizes) and first_failure is None,
        "marker_rows_cleared": {"http": clear.get("http"), "removed": cleared.get("removed")},
        "schema_clean_at_the_end": (final_schema.get("pending") == [] and final_schema.get("error") is None) if final_schema else None,
        "calls": calls,
    }
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit("usage: ramp-summary.py RESULTS_DIR COMMIT")
    main(sys.argv[1], sys.argv[2])
