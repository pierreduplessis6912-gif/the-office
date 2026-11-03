#!/usr/bin/env python3
"""The real-object re-proof of the restore-verification fix: did it hold on a real Durable Object?

Usage: restore-proof-judge.py <results dir> <the probe column the deploy added to customers> <the commit staging must be running>

THE SCENARIO: staging-two is snapshotted BEFORE a deploy; the deploy applies a temporary migration that adds a column to customers on the real object; the older snapshot is then restored. On 2026-11-02 (run 41445346938) that reported "table customers: same row count (101) but the
contents differ" and ok:false, because the restore hashed every LIVE column. The fix hashes the snapshot's own columns. This reads what the run saved and decides whether it is now PROVEN on a real object. It is VACUOUS (and says so) if the column was never added.
IT ALSO CHECKS A DEPLOYMENT RISK: the snapshot was written by the previous code and read by the new manifest validator, and every existing snapshot of each staging business must validate (unreadable: 0), or the validator is stricter than real data.
Reads rp-*.json files from the results dir; writes restore-proof.json there and prints it; exits 0 only if every check holds. The workflow and the tests run THIS file."""
import glob, json, os, sys

results, probe, expect = sys.argv[1], sys.argv[2], sys.argv[3]

def load(name):
    try:
        v = json.load(open(os.path.join(results, name)))
        return v if isinstance(v, dict) else {}
    except Exception:
        return {}

def text(name):
    try:
        return open(os.path.join(results, name)).read().strip()
    except Exception:
        return ""

tables = lambda m: {t.get("name"): t for t in (m.get("tables") or []) if isinstance(t, dict)}
columns = lambda t: {c.get("name") for c in ((t or {}).get("columns") or []) if isinstance(c, dict)}
engine_ok = lambda s: (s.get("integrity") or {}).get("ok") is True

pre, commit_doc = load("rp-pre-snapshot.json"), load("rp-health-commit.json")
before, after = tables(load("rp-manifest-before.json")), tables(load("rp-manifest-after.json"))
restore, code = load("rp-restore.json"), text("rp-restore-code.txt")
final = load("rp-health-final.json").get("schema") or {}
eng_before, eng_after = load("rp-engine-before.json"), load("rp-engine-after.json")
deployed = commit_doc.get("commit") or ""
error = str(restore.get("error") or "")

d = {}
d["a_snapshot_was_taken_before_the_deploy"] = bool(pre.get("snapshot"))
d["the_deployed_commit_is_the_one_under_test"] = bool(deployed) and bool(expect) and (deployed == expect or (len(deployed) >= 7 and expect.startswith(deployed)))
d["the_probe_column_is_on_the_real_object_before_the_restore"] = probe in columns(before.get("customers"))
d["the_validator_accepted_the_manifest_the_previous_code_wrote"] = bool(restore) and "cannot be trusted" not in error
d["the_restore_returned_200_and_ok"] = code == "200" and restore.get("ok") is True
d["the_restore_verified_clean"] = restore.get("differences") == []
d["customers_rows_are_unchanged"] = bool(before.get("customers")) and before["customers"].get("count") == (after.get("customers") or {}).get("count") and (restore.get("rowsRestored") or 0) > 0
d["the_probe_column_is_still_there_after_the_restore"] = probe in columns(after.get("customers"))
d["nothing_is_pending_after_the_retry"] = final.get("pending") == [] and final.get("error") is None
d["the_engine_is_back_exactly_and_verifies_clean"] = eng_before.get("mode") == "engine" and eng_after.get("mode") == "engine" and eng_after.get("tables") == eng_before.get("tables") and eng_after.get("hashes") == eng_before.get("hashes") and engine_ok(eng_after)

businesses = sorted(os.path.basename(p)[len("rp-backup-status-"):-len(".json")] for p in glob.glob(os.path.join(results, "rp-backup-status-*.json")))
calls = [l for l in text("rp-calls.txt").split("\n") if l.strip()]   # what the workflow's own calls did (curl exit and HTTP status): the first thing to read when a run does not prove
d["the_calls_all_completed"] = bool(calls) and all("curl_exit=0" in l for l in calls)
d["the_backup_lists_of_staging_two_were_read"] = "staging-two" in businesses and bool(load("rp-backup-list-staging-two.json"))
validated, unreadable = {}, {}
for b in businesses:
    st, ls = load("rp-backup-status-%s.json" % b), (load("rp-backup-list-%s.json" % b).get("snapshots") or [])
    validated[b] = {"snapshots": st.get("snapshots"), "complete": st.get("complete"), "unreadable": st.get("unreadable")}
    bad = [{"name": s.get("name"), "reason": s.get("unreadable")} for s in ls if isinstance(s, dict) and s.get("unreadable")]
    if bad: unreadable[b] = bad
    d["every_existing_snapshot_of_%s_validates" % b] = isinstance(st.get("snapshots"), int) and st.get("snapshots") >= 1 and st.get("unreadable") == 0

failed = [k for k, v in d.items() if isinstance(v, bool) and not v]
d["all_ok"] = not failed
d["failed"] = failed
d["details"] = {
    "pre_snapshot": pre.get("snapshot"), "deployed_commit": deployed, "expected_commit": expect, "probe_column": probe,
    "restore": {k: restore.get(k) for k in ("ok", "snapshot", "safetySnapshot", "tablesRestored", "rowsRestored", "differences", "error")}, "restore_http_status": code,
    "customers_rows": {"before_restore": (before.get("customers") or {}).get("count"), "after_restore": (after.get("customers") or {}).get("count")},
    "snapshots_validated": validated, "unreadable_snapshots": unreadable, "calls": calls,
}
if not d["a_snapshot_was_taken_before_the_deploy"]:
    d["details"]["pre_snapshot_response"] = text("rp-pre-snapshot.json")[:300]   # the start of what came back, so the cause can be read without the raw log
if not d["the_probe_column_is_on_the_real_object_before_the_restore"]:
    d["details"]["note"] = "VACUOUS: the deploy did not add the probe column to customers on the real object, so the scenario this run exists to test was not exercised (precondition not met); the run proves nothing about the fix"
with open(os.path.join(results, "restore-proof.json"), "w") as f:
    json.dump(d, f, indent=1)
print(json.dumps(d, indent=1))
sys.exit(0 if d["all_ok"] else 1)
