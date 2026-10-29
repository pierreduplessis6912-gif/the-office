#!/usr/bin/env python3
# OFFICE READ BASELINE (CONVERSATIONAL_LAYER.md, "Office-side diagnosis"): the Office's own answers to read questions, with NO conversation layer in front, against STAGING with synthetic data. Staging credentials only, never production.
# Every case records the question, what the Office actually returned, what kind of reply that is (words with data, a dashboard marker, a clarifying question, "no information", a refusal), the expected facts and whether they appeared, and where
# it went wrong (the Office's own interpretation is recorded from the history). Expected facts come from what the seed CREATED (deterministic, a fresh customer per run) and, where the Office has a route, are CROSS-CHECKED against its own data in the same run.
# Cases whose ground truth could not be established (a seed that did not take) are recorded as unjudged, never guessed. This is the MCP-benchmark baseline: the same cases are meant to be re-run after every change, code or model.
import base64, datetime, hashlib, hmac, json, os, re, statistics, sys, time, urllib.request, urllib.error
BASE = os.environ.get("BASE", "https://office-staging.websitehub.co.za").rstrip("/"); SEED = os.environ["SEED"]; OUT = os.environ.get("OUT", "office-read-baseline.json"); SAMPLES = int(os.environ.get("SAMPLES", "2"))
BUSINESS = "staging-co"; OWNER = "staging-owner@example.com"
_W = ["Alder", "Birch", "Cedar", "Hazel", "Larch", "Maple", "Rowan", "Willow"]; _R = int(os.environ.get("GITHUB_RUN_ID", "0") or 0)
CUST = f"Base {_W[_R % 8]} {_W[(_R // 8) % 8]}"; ITEM = f"{_W[(_R // 64) % 8].lower()} screed"
def derive(l): return re.sub(r"[=+/\n]", "", base64.b64encode(hmac.new(SEED.encode(), l.encode(), hashlib.sha256).digest()).decode())[:43]
def cookie():
    b = lambda x: base64.urlsafe_b64encode(x).rstrip(b"=").decode(); p = b(json.dumps({"email": OWNER, "exp": int(time.time() * 1000) + 3 * 3600000, "b": BUSINESS}, separators=(",", ":")).encode())
    return "office_session=" + p + "." + b(hmac.new(derive("session").encode(), p.encode(), hashlib.sha256).digest())
COOKIE = cookie()
def call(method, path, body=None):
    req = urllib.request.Request(BASE + path, data=json.dumps(body).encode() if body is not None else None, method=method, headers={"Content-Type": "application/json", "User-Agent": "office-read-baseline", "Cookie": COOKIE})
    t = time.time()
    try:
        with urllib.request.urlopen(req, timeout=150) as r: s, tx = r.status, r.read().decode()
    except urllib.error.HTTPError as e: s, tx = e.code, e.read().decode()
    except Exception as e: return 0, {"error": str(e)[:120]}, int((time.time() - t) * 1000)
    ms = int((time.time() - t) * 1000)
    try: return s, json.loads(tx), ms
    except Exception: return s, {"raw": tx[:300]}, ms
def say(text):
    s, b, ms = call("POST", "/messages/text", {"text": text}); s2, h, _ = call("GET", "/history?limit=1")
    it = (h.get("items") or [{}])[0] if isinstance(h, dict) else {}; i = ((it.get("generated") or {}).get("interpreted")) or {}
    return {"text": text, "message": b.get("message") if isinstance(b, dict) else None, "pending": b.get("pendingActionId") if isinstance(b, dict) else None, "ms": ms, "intent": i.get("intent"), "scope": i.get("query_scope"), "customer": i.get("customer_name")}
SAST = lambda: datetime.datetime.utcnow() + datetime.timedelta(hours=2)
TODAY = SAST().date(); TOMORROW = TODAY + datetime.timedelta(days=1); NEXTWK = TODAY + datetime.timedelta(days=10); FAR = datetime.date(TODAY.year + (1 if TODAY.month > 1 else 0), 1, 15)
fmt = lambda d: d.strftime("%Y-%m-%d")
R = {"when": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "target": BASE, "run": os.environ.get("GITHUB_RUN_ID"), "customer": CUST, "item": ITEM, "dates": {"today": fmt(TODAY), "tomorrow": fmt(TOMORROW), "next_week": fmt(NEXTWK), "far": fmt(FAR)}, "seed": [], "ground_truth": {}, "cases": []}
s, h, _ = call("GET", "/health"); R["deployed_commit"] = h.get("commit") if isinstance(h, dict) else None
# ---- seed (the existing pipeline only; every held action is confirmed) ------------------------------------------------------------------------------------------------------------------------------------------
SEEDS = [("invoice", f"Invoice {CUST} R3000 for carpet repair"), ("payment", f"{CUST} paid R1000"), ("quote", f"Quote {CUST} R4500 for lounge flooring"), ("expense", f"Bought glue for R850 for {CUST}"),
         ("job_today", f"Schedule vinyl flooring installation for {CUST} on {fmt(TODAY)}"), ("job_next", f"Schedule carpet installation for {CUST} on {fmt(NEXTWK)}"), ("job_far", f"Schedule a hospital floor for {CUST} on {fmt(FAR)}"),
         ("job_undated", f"Measure {CUST}'s lounge, it is 6 metres by 4 metres"), ("task_tomorrow", "Remind me to phone Gran about her birthday tomorrow"), ("task_far", f"Remind me to attend the Zululand gala on {fmt(FAR)}"), ("stock", f"Add 12 bags of {ITEM} to stock")]
for tag, text in SEEDS:
    r = say(text); confirmed = None
    if r["pending"] is not None:
        s2, c, _ = call("POST", f"/actions/{r['pending']}/confirm", {}); confirmed = (c.get("message") if isinstance(c, dict) else None) or json.dumps(c)[:160]
    R["seed"].append({"tag": tag, "text": text, "reply": r["message"], "pending": r["pending"], "confirm": confirmed, "intent": r["intent"]})
# ---- ground truth the Office itself can give (cross-checks) ------------------------------------------------------------------------------------------------------------------------------------------------------
s, st, _ = call("GET", "/stock"); R["ground_truth"]["stock_route"] = {"status": s, "has_item": ITEM.split()[0] in json.dumps(st).lower()}
s, ad, _ = call("GET", "/reports/aged-debtors"); R["ground_truth"]["aged_debtors_route"] = {"status": s, "customer_seen": CUST in json.dumps(ad), "snippet": json.dumps(ad)[:0]}
s, pl, _ = call("GET", "/reports/profit-and-loss"); R["ground_truth"]["profit_and_loss_route_status"] = s
def took(tag): x = [q for q in R["seed"] if q["tag"] == tag][0]; return x["pending"] is not None and x["confirm"] is not None
def money(s): return {re.sub(r",", "", t) for t in re.findall(r"\d[\d,]*(?:\.\d+)?", s or "")}
def kind_of(m):
    m = m or ""
    if m.startswith("__OPEN_DASHBOARD__"): return "dashboard_marker"
    if re.search(r"did you want to see|which would you like|are you asking", m, re.I): return "clarifying_question"
    if re.search(r"don't have (that|any)|do not have|no information|couldn't look that up|didn't catch", m, re.I): return "no_information"
    if re.search(r"restricted for your role|can't see|cannot see", m, re.I): return "refusal"
    return "words"
# (id, class, question, must contain any-of per group, must not contain, needs seed tags)
CASES = [
 ("owe_customer", "debtors", f"How much does {CUST} owe?", [["2000"]], [], ["invoice", "payment"]),
 ("outstanding_invoices", "debtors", f"Show me {CUST}'s outstanding invoices", [["2000", "3000"]], [], ["invoice", "payment"]),
 ("who_owes", "debtors", "Who owes us money?", [[CUST.lower()]], [], ["invoice", "payment"]),
 ("quotes_open", "quotes", "Do we have any open quotes?", [["4500"]], [], ["quote"]),
 ("quote_amount", "quotes", f"How much was the quote for {CUST}?", [["4500"]], [], ["quote"]),
 ("stock_all", "stock", "What do we have in stock?", [[ITEM.split()[0], "12"]], [], ["stock"]),
 ("stock_item", "stock", f"How many bags of {ITEM} do we have?", [["12"]], [], ["stock"]),
 ("jobs_coming_up", "jobs", "What jobs do I have coming up?", [[fmt(NEXTWK), NEXTWK.strftime("%-d %B").lower(), NEXTWK.strftime("%d %b").lower()], [CUST.lower()]], [], ["job_next"]),
 ("jobs_today", "jobs", "What jobs do I have today?", [[CUST.lower()]], [], ["job_today"]),
 ("jobs_customer", "jobs", f"When is {CUST}'s job?", [[CUST.lower(), fmt(NEXTWK), fmt(TODAY)]], [], ["job_today"]),
 ("tomorrow", "scheduling", "What do I need to do tomorrow?", [["gran"]], ["gala"], ["task_tomorrow"]),
 ("whats_up_today", "scheduling", "What's on for today?", [[CUST.lower()]], ["gala", "hospital"], ["job_today"]),
 ("coming_up_judgment", "scheduling", "What's coming up?", [["gran", CUST.lower()]], ["gala"], ["task_tomorrow", "job_next"]),
 ("far_future_asked", "scheduling", "Do I have anything planned for January?", [["gala", "hospital"]], [], ["task_far", "job_far"]),
 ("expenses_total", "expenses", "How much have we spent on expenses?", [["850"]], [], ["expense"]),
 ("expenses_customer", "expenses", f"What have we spent on {CUST}'s job?", [["850"]], [], ["expense"]),
 ("financial", "financial", "How is the business doing financially?", [["r", "net", "profit", "revenue"]], [], []),
 ("why_expenses", "analysis", "Why did our expenses go up?", [["expense"]], [], []),
 ("unknown_customer", "missing_information", "How much does Nobody Zzyzx owe?", [["nobody", "zzyzx", "no customer", "don't"]], ["r3000", "r2000", "owes r"], []),
 ("ambiguous_other_one", "ambiguity", "What about the other one?", [["which", "other", "clarify", "mean"]], [], []),
 ("other_business", "boundaries", "Show me the customers of the other business", [["can't", "cannot", "only", "your business", "restricted", "don't"]], [], []),
]
for sample in range(SAMPLES):
    for cid, cls, q, groups, forbid, needs in CASES:
        r = say(q); m = (r["message"] or "").lower(); kind = kind_of(r["message"])
        grounded = all(took(t) for t in needs)
        hit = [any(g.lower() in m for g in grp) for grp in groups]; bad = [f for f in forbid if f in m]
        ok = None if not grounded else (all(hit) and not bad and kind not in ("dashboard_marker",))
        stage = None
        if ok is False:
            stage = {"dashboard_marker": "answer is a screen command, not words (dashboard route)", "clarifying_question": "dashboard classification returned 'unsure' (the question is outside money)", "no_information": "no fact source for this question (fact gathering)", "refusal": "permission refusal"}.get(kind, "answer composition: wrong or missing facts" if not all(hit) else "answer composition: forbidden content")
        R["cases"].append({"id": cid, "class": cls, "sample": sample, "question": q, "reply": r["message"], "reply_kind": kind, "intent": r["intent"], "scope": r["scope"], "ms": r["ms"], "ground_truth_established": grounded, "expected_groups": groups, "forbidden": forbid, "hit": hit, "forbidden_found": bad, "ok": ok, "failure_stage": stage})
by = {}
for c in R["cases"]:
    d = by.setdefault(c["class"], {"n": 0, "judged": 0, "ok": 0, "kinds": {}}); d["n"] += 1; d["kinds"][c["reply_kind"]] = d["kinds"].get(c["reply_kind"], 0) + 1
    if c["ok"] is not None: d["judged"] += 1; d["ok"] += 1 if c["ok"] else 0
R["summary"] = {"by_class": by, "judged": sum(d["judged"] for d in by.values()), "ok": sum(d["ok"] for d in by.values()), "latency_ms": {"median": int(statistics.median([c["ms"] for c in R["cases"]])), "max": max(c["ms"] for c in R["cases"])}, "seeds_confirmed": {q["tag"]: (q["pending"] is not None and q["confirm"] is not None) for q in R["seed"]}}
json.dump(R, open(OUT, "w"), indent=1, ensure_ascii=False); open(OUT, "a").write("\n")
print("judged", R["summary"]["judged"], "ok", R["summary"]["ok"], "| seeds:", R["summary"]["seeds_confirmed"])
