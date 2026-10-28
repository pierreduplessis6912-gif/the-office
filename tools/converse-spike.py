#!/usr/bin/env python3
# Evaluation of the conversation-first front door (worker/src/converse-agent.ts) against the STAGING Worker with the REAL model. Staging credentials only, never production.
# 1) seeds a little staging data with the front door OFF; 2) runs the read and talk phrases with it OFF (the old pipeline, for comparison); 3) switches CONVERSE_MODE=agent on (a Worker secret on STAGING) and runs ~30 recorded
# phrases: talk, history, reads, Pierre's two mixed-intent messages, real instructions (must be handed to the old pipeline) and ambiguous ones; 4) rejects what the instructions held and removes the switch.
# It records plain facts and the replies to synthetic messages in OUT: which tools the model chose, whether a reply was grounded or fell back, time per message, model calls. No business data, no secret.
import base64, hashlib, hmac, json, os, re, statistics, sys, time, urllib.request, urllib.error

BASE = os.environ.get("BASE", "https://office-staging.websitehub.co.za").rstrip("/")
SEED = os.environ["SEED"]; OUT = os.environ.get("OUT", "converse-spike-last.json")
CF_TOKEN = os.environ.get("CLOUDFLARE_API_TOKEN", ""); CF_ACCOUNT = os.environ.get("CLOUDFLARE_ACCOUNT_ID", "")
WORKER = os.environ.get("WORKER", "office-staging-api"); BUSINESS = "staging-co"; OWNER = "staging-owner@example.com"
_WORDS = ["Alder", "Birch", "Cedar", "Hazel", "Larch", "Maple", "Rowan", "Willow"]   # a NEW customer every run (letters only: a digit in a name would make a read look like work), so the seed never accumulates
_RID = int(os.environ.get("GITHUB_RUN_ID", "0") or 0)
CUST = f"Spike {_WORDS[_RID % 8]} {_WORDS[(_RID // 8) % 8]}"
SAMPLES = int(os.environ.get("SAMPLES", "3"))

def derive(label):
    raw = base64.b64encode(hmac.new(SEED.encode(), label.encode(), hashlib.sha256).digest()).decode()
    return re.sub(r"[=+/\n]", "", raw)[:43]
SESSION = derive("session")
def cookie():
    b = lambda x: base64.urlsafe_b64encode(x).rstrip(b"=").decode()
    p = b(json.dumps({"email": OWNER, "exp": int(time.time() * 1000) + 3600000, "b": BUSINESS}, separators=(",", ":")).encode())
    return "office_session=" + p + "." + b(hmac.new(SESSION.encode(), p.encode(), hashlib.sha256).digest())
COOKIE = cookie()

def call(method, path, body=None):
    headers = {"Content-Type": "application/json", "User-Agent": "converse-spike", "Cookie": COOKIE}
    req = urllib.request.Request(BASE + path, data=json.dumps(body).encode() if body is not None else None, method=method, headers=headers)
    t = time.time()
    try:
        with urllib.request.urlopen(req, timeout=120) as r: status, text = r.status, r.read().decode()
    except urllib.error.HTTPError as e: status, text = e.code, e.read().decode()
    except Exception as e: return 0, {"error": str(e)[:120]}, int((time.time() - t) * 1000)
    ms = int((time.time() - t) * 1000)
    try: return status, json.loads(text), ms
    except Exception: return status, {"raw": text[:200]}, ms

def cf_secret(method, name, text="agent"):
    url = f"https://api.cloudflare.com/client/v4/accounts/{CF_ACCOUNT}/workers/scripts/{WORKER}/secrets" + ("" if method == "PUT" else f"/{name}")
    data = json.dumps({"name": name, "text": text, "type": "secret_text"}).encode() if method == "PUT" else None
    req = urllib.request.Request(url, data=data, method=method, headers={"Authorization": f"Bearer {CF_TOKEN}", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r: return r.status
    except urllib.error.HTTPError as e: return e.code
    except Exception: return 0

def say(text):
    s, b, ms = call("POST", "/messages/text", {"text": text})
    msg = b.get("message") if isinstance(b, dict) else None
    s2, h, _ = call("GET", "/history?limit=1")
    it = (h.get("items") or [{}])[0] if isinstance(h, dict) else {}
    interp = ((it.get("generated") or {}).get("interpreted")) or {}
    return {"text": text, "status": s, "message": msg, "ms": ms, "pending": b.get("pendingActionId") if isinstance(b, dict) else None,
            "converse": interp.get("converse"), "outcome": interp.get("outcome"), "steps": interp.get("steps"), "tools": interp.get("tools"), "intent": interp.get("intent"), "reason": interp.get("reason"), "rejected": interp.get("rejected")}

def figs(s): return {re.sub(r",", "", t) for t in re.findall(r"\d[\d,]*(?:\.\d+)?", s or "")}
def stats(xs): return {"n": len(xs), "median": int(statistics.median(xs)) if xs else None, "mean": int(statistics.mean(xs)) if xs else None, "max": max(xs) if xs else None}

R = {"when": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "target": BASE, "run": os.environ.get("GITHUB_RUN_ID"), "seed": [], "baseline": [], "agent": [], "summary": {}}
s, h, _ = call("GET", "/health"); R["deployed_commit"] = h.get("commit") if isinstance(h, dict) else None
R["expected_commit"] = os.environ.get("EXPECT_COMMIT", ""); R["runs_expected_commit"] = bool(R["expected_commit"]) and R["deployed_commit"] == R["expected_commit"]

def confirm_all(): 
    s, p, _ = call("GET", "/embers/pending")
    for a in (p.get("pending", []) if isinstance(p, dict) else []):
        if CUST in (a.get("source_transcript") or "") or "Spike" in (a.get("source_transcript") or ""): call("POST", f"/actions/{a['id']}/confirm", {})
# 1) seed with the front door off (the existing pipeline only)
cf_secret("DELETE", "CONVERSE_MODE"); time.sleep(8)
for t in [f"Invoice {CUST} R3000 for carpet repair", f"{CUST} paid R1000", "Bought glue for R850 at BUCO"]:
    r = say(t); R["seed"].append({"text": t, "message": r["message"], "pending": r["pending"]})
    if r["pending"] is not None: call("POST", f"/actions/{r['pending']}/confirm", {})

PHRASES = [  # (kind, text, expected tools (any of) or None, expected figures (any of) or None)
 ("talk", "Hello Office", None, None), ("talk", "Good morning, Office. How are you doing today?", None, None), ("talk", "I want to have a conversation with you", None, None),
 ("talk", "Who are you?", None, None), ("talk", "What can you help me with?", None, None), ("talk", "Can you explain what you can help me with?", None, None),
 ("talk", "I had a difficult day yesterday and wanted to talk through something.", None, None), ("talk", "Thanks, that is all for now", None, None),
 ("recall", "I was thinking about how the week has gone", None, None), ("recall", "Do you remember what I just said?", None, ["week"]),
 ("read", f"How much does {CUST} owe?", ["get_customer_receivables", "get_aged_debtors", "list_invoices"], ["2000", "3000"]),
 ("read", "Who owes us money?", ["get_aged_debtors", "list_invoices"], ["2000"]),
 ("read", f"Show me {CUST}'s outstanding invoices", ["get_customer_receivables", "list_invoices"], ["2000", "3000"]),
 ("read", "How much have we spent on expenses?", ["list_expenses", "get_profit_and_loss", "analyse"], ["850"]),
 ("read", "How is the business doing financially?", ["get_profit_and_loss", "analyse", "get_aged_debtors"], None),
 ("read", "Do we have any open quotes?", ["list_quotes"], None), ("read", "What do we have in stock?", ["get_stock"], None), ("read", "What jobs do I have coming up?", ["list_jobs"], None),
 ("mixed", f"Morning, Office. How are we looking on {CUST}'s outstanding invoices?", ["get_customer_receivables", "list_invoices", "get_aged_debtors"], ["2000", "3000"]),
 ("mixed", f"Hello, can you tell me what {CUST} owes and then help me understand why our debtors are increasing?", ["get_customer_receivables", "list_invoices", "get_aged_debtors", "analyse"], ["2000", "3000"]),
 ("work", f"{CUST} paid R500", None, None), ("work", f"Invoice {CUST} R1200 for a window repair", None, None), ("work", "Remind me to call Thandi tomorrow", None, None), ("work", "Bought diesel for R650", None, None), ("work", "Add 5 boards to stock", None, None),
 ("ambiguous", "hmm", None, None), ("ambiguous", "ok", None, None), ("ambiguous", "what about the other one", None, None),
]
# 2) the old pipeline on the talk, read and mixed phrases, for comparison
for kind, text, tools, fig in PHRASES:
    if kind in ("work", "recall"): continue
    r = say(text); r["kind"] = kind; R["baseline"].append(r)
# 3) the front door on
put = cf_secret("PUT", "CONVERSE_MODE", "agent"); R["switch_put_status"] = put
active = False
try:
    # A warm business object keeps its old settings until it restarts: wait (up to ~7 minutes) until a plain greeting is really handled by the front door, and do NOT evaluate anything if it never is.
    for _ in range(42):
        time.sleep(10); r = say("Hello Office")
        if r["converse"] == "agent": active = True; break
    R["front_door_active"] = active
    if not active: raise SystemExit("front door never became active: nothing evaluated")
    held = []
    for sample, (kind, text, tools, fig) in [(n, ph) for n in range(SAMPLES) for ph in PHRASES if not (ph[0] == "work" and n > 0)]:
        r = say(text); r["kind"] = kind; r["sample"] = sample
        ok = None
        if kind in ("talk", "recall", "ambiguous"):
            ok = r["converse"] == "agent" and r["outcome"] == "reply" and not r["tools"]
            if kind == "recall" and fig: ok = ok and any(f in (r["message"] or "").lower() for f in fig)
            if kind == "ambiguous": ok = None
        elif kind in ("read", "mixed"):
            used = r["tools"] or []
            r["tool_ok"] = any(t in used for t in tools) if tools else None
            r["figure_ok"] = any(f in figs(r["message"]) for f in fig) if fig else None
            ok = r["converse"] == "agent" and r["outcome"] == "reply" and r["tool_ok"] is True and (r["figure_ok"] is not False)
        elif kind == "work":
            ok = r["converse"] != "agent" and (r["pending"] is not None or r["intent"] is not None or bool(re.search(r"noted|confirmation|reminder|recorded", r["message"] or "", re.I)))
            if r["pending"] is not None: held.append(r["pending"])
        r["ok"] = ok; R["agent"].append(r)
    for a in held: call("POST", f"/actions/{a}/reject", {})
except SystemExit:
    R["aborted"] = "the front door never became active; nothing was evaluated"
finally:
    R["switch_delete_status"] = cf_secret("DELETE", "CONVERSE_MODE")

def by(kind, rows): return [r for r in rows if r.get("kind") == kind]
S = R["summary"]
for kind in ("talk", "recall", "read", "mixed", "work", "ambiguous"):
    rows = by(kind, R["agent"]); judged = [r for r in rows if r["ok"] is not None]
    S[kind] = {"n": len(rows), "judged": len(judged), "ok": sum(1 for r in judged if r["ok"]), "fallbacks": sum(1 for r in rows if r["outcome"] == "fallback"), "latency_ms": stats([r["ms"] for r in rows])}
    base = by(kind, R["baseline"]); S[kind]["baseline_latency_ms"] = stats([r["ms"] for r in base]) if base else None
from collections import Counter
S["fallback_reasons"] = dict(Counter(r.get("reason") for r in R["agent"] if r.get("outcome") == "fallback"))
per = {}
for r in R["agent"]:
    d = per.setdefault(r["text"], {"kind": r["kind"], "n": 0, "ok": 0, "judged": 0, "fallbacks": 0, "ms": []})
    d["n"] += 1; d["ms"].append(r["ms"]); d["fallbacks"] += 1 if r.get("outcome") == "fallback" else 0
    if r["ok"] is not None: d["judged"] += 1; d["ok"] += 1 if r["ok"] else 0
S["by_phrase"] = {t: {**{k: v for k, v in d.items() if k != "ms"}, "median_ms": int(statistics.median(d["ms"]))} for t, d in per.items()}
replies = [r for r in R["agent"] if r["converse"] == "agent"]
S["all_agent_replies"] = {"n": len(replies), "model_calls_mean": round(statistics.mean([r["steps"] for r in replies]), 2) if replies else None, "model_calls_max": max([r["steps"] for r in replies]) if replies else None, "fallback_rate": round(sum(1 for r in replies if r["outcome"] == "fallback") / len(replies), 3) if replies else None}
json.dump(R, open(OUT, "w"), indent=1, ensure_ascii=False); open(OUT, "a").write("\n")
print("front door active:", active, "| summary:", json.dumps({k: (v.get("ok"), v.get("judged")) for k, v in S.items() if isinstance(v, dict) and "judged" in v}))
sys.exit(0)
