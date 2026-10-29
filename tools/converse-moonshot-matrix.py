#!/usr/bin/env python3
# The Moonshot front door matrix (worker/src/converse-moonshot.ts), against the STAGING Worker with the REAL models. Staging credentials only, synthetic messages only, never production.
# Seeds a little staging data with the front door off, runs the phrases through the OLD pipeline once (baseline), then through each configuration (model, thinking, policy) chosen PER REQUEST with the X-Converse-Config header
# (which the Worker honours only on staging), and records plain facts and replies: routing (talk or engine), whether the person got the engine's words or a narration, time (total, model calls, tokens), refusals.
import base64, hashlib, hmac, json, os, re, statistics, sys, time, urllib.request, urllib.error
BASE = os.environ.get("BASE", "https://office-staging.websitehub.co.za").rstrip("/")
SEED = os.environ["SEED"]; OUT = os.environ.get("OUT", "converse-moonshot-matrix.json"); SAMPLES = int(os.environ.get("SAMPLES", "2"))
BUSINESS = "staging-co"; OWNER = "staging-owner@example.com"
_WORDS = ["Alder", "Birch", "Cedar", "Hazel", "Larch", "Maple", "Rowan", "Willow"]
_RID = int(os.environ.get("GITHUB_RUN_ID", "0") or 0); CUST = f"Spike {_WORDS[_RID % 8]} {_WORDS[(_RID // 8) % 8]}"
DEFAULT_CONFIGS = [{"model": "kimi-k2.6", "thinking": "off"}, {"model": "kimi-k2.6", "thinking": "on"}, {"model": "kimi-k2.7-code", "thinking": "on"}, {"model": "kimi-k2.7-code-highspeed", "thinking": "on"}]
CONFIGS = [{**c, "policy": p, "effort": "low"} for p in ("A", "B") for c in json.loads(os.environ.get("CONFIGS", "null") or "null") or DEFAULT_CONFIGS]
def derive(label):
    raw = base64.b64encode(hmac.new(SEED.encode(), label.encode(), hashlib.sha256).digest()).decode(); return re.sub(r"[=+/\n]", "", raw)[:43]
def cookie():
    b = lambda x: base64.urlsafe_b64encode(x).rstrip(b"=").decode()
    p = b(json.dumps({"email": OWNER, "exp": int(time.time() * 1000) + 3 * 3600000, "b": BUSINESS}, separators=(",", ":")).encode())
    return "office_session=" + p + "." + b(hmac.new(derive("session").encode(), p.encode(), hashlib.sha256).digest())
COOKIE = cookie()
def call(method, path, body=None, cfg=None):
    headers = {"Content-Type": "application/json", "User-Agent": "converse-matrix", "Cookie": COOKIE}
    if cfg: headers["X-Converse-Config"] = json.dumps({"mode": "moonshot", **cfg})
    req = urllib.request.Request(BASE + path, data=json.dumps(body).encode() if body is not None else None, method=method, headers=headers)
    t = time.time()
    try:
        with urllib.request.urlopen(req, timeout=150) as r: status, text = r.status, r.read().decode()
    except urllib.error.HTTPError as e: status, text = e.code, e.read().decode()
    except Exception as e: return 0, {"error": str(e)[:120]}, int((time.time() - t) * 1000)
    ms = int((time.time() - t) * 1000)
    try: return status, json.loads(text), ms
    except Exception: return status, {"raw": text[:200]}, ms
def say(text, cfg=None):
    s, b, ms = call("POST", "/messages/text", {"text": text}, cfg)
    s2, h, _ = call("GET", "/history?limit=1")
    it = (h.get("items") or [{}])[0] if isinstance(h, dict) else {}
    i = ((it.get("generated") or {}).get("interpreted")) or {}; m = i.get("moonshot") or {}
    return {"text": text, "status": s, "message": b.get("message") if isinstance(b, dict) else None, "ms": ms, "pending": b.get("pendingActionId") if isinstance(b, dict) else None,
            "converse": i.get("converse"), "outcome": m.get("outcome"), "via": m.get("via"), "reason": m.get("reason"), "model_ms": m.get("model_ms"), "tokens": m.get("tokens"), "narrated": m.get("narrated"), "intent": i.get("intent")}
def figs(s): return {re.sub(r",", "", t) for t in re.findall(r"\d[\d,]*(?:\.\d+)?", s or "")}
def stats(xs): return {"n": len(xs), "median": int(statistics.median(xs)) if xs else None, "mean": int(statistics.mean(xs)) if xs else None, "p90": sorted(xs)[int(len(xs) * .9)] if xs else None, "max": max(xs) if xs else None}
BAD = re.compile(r"don't have that on file|couldn't look that up|didn't catch|trouble responding", re.I)
R = {"when": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "target": BASE, "run": os.environ.get("GITHUB_RUN_ID"), "customer": CUST, "samples": SAMPLES, "configs": [], "baseline": [], "seed": []}
s, h, _ = call("GET", "/health"); R["deployed_commit"] = h.get("commit") if isinstance(h, dict) else None
R["expected_commit"] = os.environ.get("EXPECT_COMMIT", ""); R["runs_expected_commit"] = bool(R["expected_commit"]) and R["deployed_commit"] == R["expected_commit"]
PHRASES = [
 ("talk", "Hello Office", None), ("talk", "Good morning, Office. How are you doing today?", None), ("talk", "I want to have a conversation with you", None), ("talk", "Who are you?", None), ("talk", "What can you help me with?", None),
 ("talk", "Can you explain what you can help me with?", None), ("talk", "I had a difficult day yesterday and wanted to talk through something.", None), ("talk", "Thanks, that is all for now", None),
 ("recall", "I was thinking about how the week has gone", None), ("recall", "Do you remember what I just said?", ["week"]),
 ("read", f"How much does {CUST} owe?", ["2000", "3000"]), ("read", "Who owes us money?", None), ("read", f"Show me {CUST}'s outstanding invoices", ["2000", "3000"]), ("read", "How much have we spent on expenses?", None),
 ("read", "How is the business doing financially?", None), ("read", "Do we have any open quotes?", None), ("read", "What do we have in stock?", None), ("read", "What jobs do I have coming up?", None),
 ("mixed", f"Morning, Office. How are we looking on {CUST}'s outstanding invoices?", ["2000", "3000"]), ("mixed", f"Hello, can you tell me what {CUST} owes and then help me understand why our debtors are increasing?", ["2000", "3000"]),
 ("work", f"{CUST} paid R500", None), ("work", f"Invoice {CUST} R1200 for a window repair", None), ("work", "Remind me to call Thandi tomorrow", None), ("work", "Bought diesel for R650", None), ("work", "Add 5 boards to stock", None),
 ("ambiguous", "hmm", None), ("ambiguous", "ok", None), ("ambiguous", "what about the other one", None)]
for t in [f"Invoice {CUST} R3000 for carpet repair", f"{CUST} paid R1000", "Bought glue for R850 at BUCO"]:
    r = say(t); R["seed"].append({"text": t, "message": r["message"], "pending": r["pending"]})
    if r["pending"] is not None: call("POST", f"/actions/{r['pending']}/confirm", {})
for kind, text, fig in PHRASES:
    if kind in ("work", "recall"): continue
    r = say(text); r["kind"] = kind; R["baseline"].append(r)
held = []
def judge(kind, fig, r):
    routed_talk = r["converse"] == "moonshot" and r["outcome"] == "reply"; routed_engine = r["outcome"] == "engine"
    if kind in ("talk", "recall"):
        ok = routed_talk
        if kind == "recall" and fig: ok = ok and any(f in (r["message"] or "").lower() for f in fig)
        return ok
    if kind in ("read", "mixed"):
        ok = routed_engine and not BAD.search(r["message"] or "")
        if fig: ok = ok and any(f in figs(r["message"]) for f in fig)
        return ok
    if kind == "work": return routed_engine and (r["pending"] is not None or r["intent"] is not None)
    return None
for cfg in CONFIGS:
    rows = []
    for sample in range(SAMPLES):
        for kind, text, fig in PHRASES:
            if kind == "work" and sample > 0: continue
            r = say(text, cfg); r["kind"] = kind; r["sample"] = sample; r["ok"] = judge(kind, fig, r)
            if r["pending"] is not None and kind == "work": held.append(r["pending"])
            rows.append(r)
    S = {}
    for kind in ("talk", "recall", "read", "mixed", "work", "ambiguous"):
        k = [r for r in rows if r["kind"] == kind]; j = [r for r in k if r["ok"] is not None]
        S[kind] = {"n": len(k), "ok": sum(1 for r in j if r["ok"]), "judged": len(j), "latency_ms": stats([r["ms"] for r in k])}
    allms = [r["ms"] for r in rows]; calls = [m for r in rows for m in (r.get("model_ms") or [])]
    S["all"] = {"latency_ms": stats(allms), "model_call_ms": stats(calls), "model_calls": len(calls), "tokens_in": sum((r.get("tokens") or {}).get("in", 0) for r in rows), "tokens_out": sum((r.get("tokens") or {}).get("out", 0) for r in rows),
                "fallbacks": sum(1 for r in rows if r["outcome"] == "fallback"), "errors": sum(1 for r in rows if r["outcome"] in (None, "error") and r["kind"] not in ("work",)), "narrated": sum(1 for r in rows if r.get("narrated"))}
    R["configs"].append({"config": cfg, "summary": S, "rows": rows})
    json.dump(R, open(OUT, "w"), indent=1, ensure_ascii=False)
for a in held: call("POST", f"/actions/{a}/reject", {})
json.dump(R, open(OUT, "w"), indent=1, ensure_ascii=False); open(OUT, "a").write("\n")
print("configs run:", len(R["configs"]))
sys.exit(0)
