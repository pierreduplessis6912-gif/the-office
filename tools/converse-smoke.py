#!/usr/bin/env python3
# Smoke test of the conversational layer against the STAGING Worker (real Kimi, real Durable Objects), the same code as production. Uses only staging credentials; never production.
# Records what happened as plain facts in OUT (the replies are Kimi's words to synthetic staging messages: no business data, no secret). Run by .github/workflows/converse-smoke.yml.
import base64, hashlib, hmac, json, os, re, statistics, sys, time, urllib.request, urllib.error

BASE = os.environ.get("BASE", "https://office-staging.websitehub.co.za").rstrip("/")
SEED = os.environ["SEED"]; OUT = os.environ.get("OUT", "converse-smoke-last.json")
CF_TOKEN = os.environ.get("CLOUDFLARE_API_TOKEN", ""); CF_ACCOUNT = os.environ.get("CLOUDFLARE_ACCOUNT_ID", "")
WORKER = os.environ.get("WORKER", "office-staging-api"); BUSINESS = "staging-co"; OWNER = "staging-owner@example.com"
NO_INTENT = "I didn't catch anything there I could act on."

def derive(label):
    raw = base64.b64encode(hmac.new(SEED.encode(), label.encode(), hashlib.sha256).digest()).decode()
    return re.sub(r"[=+/\n]", "", raw)[:43]
ADMIN, CONFIRM, SESSION = derive("admin"), derive("confirm"), derive("session")
def cookie():
    b = lambda x: base64.urlsafe_b64encode(x).rstrip(b"=").decode()
    p = b(json.dumps({"email": OWNER, "exp": int(time.time() * 1000) + 3600000, "b": BUSINESS}, separators=(",", ":")).encode())
    return "office_session=" + p + "." + b(hmac.new(SESSION.encode(), p.encode(), hashlib.sha256).digest())
COOKIE = cookie()

def call(method, path, body=None, admin=False, url=None):
    headers = {"Content-Type": "application/json", "User-Agent": "converse-smoke"}
    if admin: headers.update({"X-Admin-Key": ADMIN, "X-Admin-Confirm": CONFIRM, "X-Target-Business": BUSINESS})
    else: headers["Cookie"] = COOKIE
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url or BASE + path, data=data, method=method, headers=headers)
    t = time.time()
    try:
        with urllib.request.urlopen(req, timeout=90) as r: status, text = r.status, r.read().decode()
    except urllib.error.HTTPError as e: status, text = e.code, e.read().decode()
    except Exception as e: return 0, {"error": str(e)[:120]}, int((time.time() - t) * 1000)
    ms = int((time.time() - t) * 1000)
    try: return status, json.loads(text), ms
    except Exception: return status, {"raw": text[:200]}, ms

def say(text):
    s, b, ms = call("POST", "/messages/text", {"text": text})
    return {"status": s, "message": b.get("message") if isinstance(b, dict) else None, "pendingActionId": b.get("pendingActionId") if isinstance(b, dict) else None, "ms": ms}

def cf_secret(method, name="CONVERSE", text="off"):
    url = f"https://api.cloudflare.com/client/v4/accounts/{CF_ACCOUNT}/workers/scripts/{WORKER}/secrets" + ("" if method == "PUT" else f"/{name}")
    data = json.dumps({"name": name, "text": text, "type": "secret_text"}).encode() if method == "PUT" else None
    req = urllib.request.Request(url, data=data, method=method, headers={"Authorization": f"Bearer {CF_TOKEN}", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r: return r.status
    except urllib.error.HTTPError as e: return e.code
    except Exception: return 0

def customers():
    s, b, _ = call("GET", "/customers"); return (b.get("items") if isinstance(b, dict) else None) or []
def pending():
    s, b, _ = call("GET", "/embers/pending"); return len(b.get("pending", [])) if isinstance(b, dict) else -1
def stats(xs): return {"n": len(xs), "ms": xs, "median": int(statistics.median(xs)) if xs else None, "mean": int(statistics.mean(xs)) if xs else None, "max": max(xs) if xs else None}
def conversational(r): return r["status"] == 200 and isinstance(r["message"], str) and r["message"] != NO_INTENT and len(r["message"]) > 0

R = {"when": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "target": BASE, "run": os.environ.get("GITHUB_RUN_ID"), "checks": {}, "replies": {}}
C = R["checks"]
s, h, _ = call("GET", "/health"); R["deployed_commit"] = h.get("commit") if isinstance(h, dict) else None
expect = os.environ.get("EXPECT_COMMIT", "")
C["staging_runs_the_expected_commit"] = bool(expect) and R["deployed_commit"] == expect

c0, p0 = len(customers()), pending()
g1 = say("Hello Office"); R["replies"]["greeting"] = g1["message"]; C["greeting_gets_a_conversational_reply"] = conversational(g1)
g2 = say("I want to have a conversation with you"); R["replies"]["i_want_to_have_a_conversation"] = g2["message"]; C["conversation_request_is_not_the_old_failure"] = conversational(g2)
say("I have had a long day")
g3 = say("Do you know what I just told you about my day?"); R["replies"]["follow_up"] = g3["message"]
C["follow_up_uses_the_previous_turn"] = conversational(g3) and bool(re.search(r"long|day|tir|rough|hard", g3["message"] or "", re.I))
g4 = say("What can you help me with?"); R["replies"]["capabilities"] = g4["message"]; C["capabilities_reply_is_conversational"] = conversational(g4)
s, hist, _ = call("GET", "/history?limit=6")
items = hist.get("items", []) if isinstance(hist, dict) else []
C["conversation_wrote_no_business_record_or_held_action"] = len(items) >= 5 and all(not it.get("recordsWritten") and not it.get("proposed") for it in items[:5]) and len(customers()) == c0 and pending() == p0

names = [c.get("name") for c in customers() if c.get("name")]
who = names[0] if names else "Staging Customer One"
ins = say(f"{who} paid R500"); R["replies"]["business_instruction"] = ins["message"]
C["business_instruction_still_held_for_confirmation"] = ins["status"] == 200 and ins["pendingActionId"] is not None and bool(re.search(r"needs your confirmation", ins["message"] or ""))
if ins["pendingActionId"] is not None: call("POST", f"/actions/{ins['pendingActionId']}/reject", {})
C["held_instruction_rejected_and_staging_left_as_found"] = pending() == p0

on = [say(t) for t in ["Hello Office", "Good morning Office", "Hi there", "Hey Office, how are you", "Hello again"]]
R["latency_on"] = stats([r["ms"] for r in on]); R["replies"]["on_samples"] = [r["message"] for r in on]; C["all_greeting_samples_conversational"] = all(conversational(r) for r in on)

off_ok = restored_ok = False
try:
    R["switch_put_status"] = cf_secret("PUT")
    for _ in range(14):
        time.sleep(5); r = say("Hello Office")
        if r["message"] == NO_INTENT: off_ok = True; break
    C["converse_off_restores_the_original_reply_exactly"] = off_ok
    off = [say(t) for t in ["Hello Office", "Good morning Office", "Hi there", "Hey Office, how are you", "Hello again"]]
    R["latency_off"] = stats([r["ms"] for r in off]); C["off_samples_all_original_reply"] = all(r["message"] == NO_INTENT for r in off)
finally:
    R["switch_delete_status"] = cf_secret("DELETE")
for _ in range(14):
    time.sleep(5); r = say("Hello Office")
    if conversational(r): restored_ok = True; break
C["converse_on_again_after_the_switch_is_removed"] = restored_ok
if R.get("latency_on", {}).get("median") is not None and R.get("latency_off", {}).get("median") is not None:
    R["added_by_the_layer_ms"] = {"median": R["latency_on"]["median"] - R["latency_off"]["median"], "mean": R["latency_on"]["mean"] - R["latency_off"]["mean"]}

s, t, _ = call("GET", "/debug/timings", admin=True)
rows = []
def walk(x):
    if isinstance(x, dict):
        if "prompt" in x and ("meanMs" in x or "calls" in x): rows.append({k: x[k] for k in ("prompt", "calls", "meanMs", "maxMs", "failures") if k in x})
        for v in x.values(): walk(v)
    elif isinstance(x, list):
        for v in x: walk(v)
walk(t); R["model_call_timings_by_prompt"] = rows; R["timings_status"] = s
json.dump(R, open(OUT, "w"), indent=1, ensure_ascii=False); open(OUT, "a").write("\n")
bad = [k for k, v in C.items() if v is not True]
print("checks:", len(C), "failed:", bad)
sys.exit(0 if not bad else 1)
