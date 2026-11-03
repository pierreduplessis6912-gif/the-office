#!/usr/bin/env python3
"""Reads, and ONLY reads, what real staging business objects report about their own identity.

WHY: business-object.ts refuses a claim that does not match the name an object was addressed by (objectNameFor(business) = "business-<id>"), but only if the runtime tells the object that name. Whether the production
runtime does is unknown from the code, so this reads /admin/health on real objects (object.name, object.identityVisible) and records the answer. It issues only GET requests, prints no key, changes nothing on staging.

THE ANSWERS (verdict): runtime_exposes_the_object_name_and_it_matches (the fix is effective there) | runtime_exposes_no_object_name (the fix is inert there; the older first-claim binding is all that remains) |
runtime_exposes_the_name_but_it_does_not_match (UNSAFE: the fix would refuse legitimate claims; fails the run) | the_fix_is_not_deployed (fails) | commit_mismatch (fails, nothing read) | unreachable (fails).
Exit 0 only for the first two. Environment: SEED (the staging key seed), EXPECT_COMMIT (the commit staging must run), OUT (where the record goes), BASE and BUSINESSES (optional; default to staging's host and its two businesses)."""
import base64, datetime, hashlib, hmac, json, os, re, sys, urllib.error, urllib.request

SEED = os.environ["SEED"]
OUT = os.environ.get("OUT", "staging-identity-last.json")
BASE = os.environ.get("BASE", "https://office-staging.websitehub.co.za").rstrip("/")
EXPECT = os.environ.get("EXPECT_COMMIT", "")
BUSINESSES = [b.strip() for b in (os.environ.get("BUSINESSES") or "staging-co,staging-two").split(",") if b.strip()]

def derive(label):   # the same derivation staging.yml uses: base64(hmac-sha256(seed, label)) without = + / and newlines, first 43 characters
    raw = base64.b64encode(hmac.new(SEED.encode(), label.encode(), hashlib.sha256).digest()).decode()
    return re.sub(r"[=+/\n]", "", raw)[:43]
ADMIN = derive("admin")

def get(path, admin_target=None):   # the ONLY kind of request this script makes
    headers = {"User-Agent": "staging-identity", "Accept": "application/json"}
    if admin_target: headers.update({"X-Admin-Key": ADMIN, "X-Target-Business": admin_target})
    req = urllib.request.Request(BASE + path, method="GET", headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=60) as r: status, text = r.status, r.read().decode()
    except urllib.error.HTTPError as e: status, text = e.code, e.read().decode()
    except Exception: return None, None
    try: return status, json.loads(text)
    except Exception: return status, None

record = {"when": datetime.datetime.utcnow().isoformat() + "Z", "run": os.environ.get("GITHUB_RUN_ID"), "expected_commit": EXPECT, "deployed_commit": None, "businesses": {}, "verdict": None}
def finish(verdict, code):
    record["verdict"] = verdict
    with open(OUT, "w") as f: json.dump(record, f, indent=2)
    print("verdict:", verdict); sys.exit(code)

status, h = get("/health")
record["deployed_commit"] = h.get("commit") if isinstance(h, dict) else None
if not EXPECT or record["deployed_commit"] != EXPECT: finish("commit_mismatch", 1)   # nothing about any object is read: the record must not describe the wrong code

for b in BUSINESSES:
    status, rep = get("/admin/health", b)
    entry = {"http_status": status, "reachable": bool(status == 200 and isinstance(rep, dict)), "business": None, "has_object_field": False, "identity_visible": None, "object_name": None, "name_matches": None}
    if entry["reachable"]:
        entry["business"] = rep.get("business"); obj = rep.get("object")
        entry["has_object_field"] = isinstance(obj, dict)
        if entry["has_object_field"]:
            entry["identity_visible"] = obj.get("identityVisible") is True; entry["object_name"] = obj.get("name")
            entry["name_matches"] = (obj.get("name") == "business-" + b) if entry["identity_visible"] else None
    record["businesses"][b] = entry

es = list(record["businesses"].values())
if not es or not all(e["reachable"] for e in es): finish("unreachable", 1)
if not all(e["has_object_field"] for e in es): finish("the_fix_is_not_deployed", 1)
if any(e["identity_visible"] and not e["name_matches"] for e in es): finish("runtime_exposes_the_name_but_it_does_not_match", 1)
if all(e["identity_visible"] and e["name_matches"] for e in es): finish("runtime_exposes_the_object_name_and_it_matches", 0)
finish("runtime_exposes_no_object_name", 0)
