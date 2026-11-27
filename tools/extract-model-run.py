# The REAL model run for the ai.ts extractions (staging mode extract-model-run), judged against the pass rule written in docs/decisions/extract-model-run.md BEFORE the run.
# A real model, through POST /debug/extract-probe (admin key, writes nothing) on a FRESH staging business, is asked the 14 cases below; every answer is scored. Safety: every check must pass. Understanding: at least 12 of 14.
# It reads its secrets from the environment and never prints them; it always writes ONE valid JSON record on stdout (the cases, the answers, which model answered each, scores, any crash trace).
import os, json, datetime, urllib.request, urllib.error
BASE, BIZ, RUN = os.environ["BASE"], os.environ["BIZ"], os.environ["RUN"]
ADMIN = {"X-Admin-Key": os.environ["STAGING_ADMIN_KEY"], "X-Admin-Confirm": os.environ["STAGING_CONFIRM_KEY"], "X-Target-Business": BIZ}
samples = {}; crash = None; results = []; ctx = {}
def call(name, method, path, body=None):
    h = {"Content-Type": "application/json", "User-Agent": "curl/8.5.0"}; h.update(ADMIN)
    req = urllib.request.Request(BASE + path, data=(json.dumps(body).encode() if body is not None else None), headers=h, method=method)
    try:
        r = urllib.request.urlopen(req, timeout=180); code, txt = r.status, r.read()
    except urllib.error.HTTPError as e: code, txt = e.code, e.read()
    except Exception: code, txt = 0, b""
    try: data = json.loads(txt)
    except Exception: data = {}
    if code != 200 and len(samples) < 40: samples[name] = txt[:200].decode("utf-8", "replace")
    return code, data
low = lambda v: json.dumps(v, ensure_ascii=False).lower()
ITEMS = [{"name": "Plywood 18mm", "unit": "sheet"}, {"name": "Screws", "unit": "box"}]
# id, function, the inputs, whether it is a "records" route (Cloudflare only), the check on the result
CASES = [
 ("U1", "extractStockUsage", {"text": "Used 3 sheets of plywood on the Mokoena lounge", "stockItems": ITEMS}, True,
   lambda r: (r or {}).get("matched_item_name") == "Plywood 18mm" and (r or {}).get("quantity_used") == 3 and "mokoena" in low((r or {}).get("job_customer_name"))),
 ("U2", "extractStocktake", {"text": "Counted 8 sheets of plywood in the store", "stockItems": ITEMS}, True,
   lambda r: (r or {}).get("matched_item_name") == "Plywood 18mm" and (r or {}).get("quantity_counted") == 8),
 ("U3", "extractSnag", {"text": "The skirting in the Dlamini bedroom is chipped"}, False, lambda r: "skirting" in low(r)),
 ("U4", "extractLead", {"text": "New lead, Thandi Zulu wants a blinds quote, she found us on Facebook"}, False,
   lambda r: "thandi" in low((r or {}).get("name")) and "blind" in low((r or {}).get("interest")) and "facebook" in low((r or {}).get("source"))),
 ("U5", "extractLeadLost", {"text": "Thandi Zulu went with someone else", "openLeads": [{"name": "Thandi Zulu"}, {"name": "Peter Naidoo"}]}, True,
   lambda r: (r or {}).get("matched_name") == "Thandi Zulu"),
 ("U6", "classifyExpenseCategory", {"text": "Diesel for the bakkie"}, False, lambda r: r == "fuel"),
 ("U7", "classifyDashboardIntent", {"text": "How much are people owing me?"}, False, lambda r: r == "aged_debtors"),
 ("U8", "containsBackwardReference", {"text": "What about her balance?"}, False, lambda r: r is True),
 ("U9", "containsBackwardReference", {"text": "What is Mokoena's balance?"}, False, lambda r: r is False),
 ("U10", "answerFromMemory", {"text": "What flooring did Mokoena choose?", "facts": ["Mokoena chose oak vinyl plank for the lounge."]}, True, lambda r: "oak" in low(r)),
 ("U11", "resolveFollowUpEntity", {"history": [{"role": "user", "text": "What does Dlamini owe me?"}, {"role": "office", "text": "Dlamini owes R1,200."}], "text": "whats her balance?"}, True, lambda r: "dlamini" in low(r)),
 ("U12", "extractLineItems", {"text": "Supply and fit 20 square metres of oak vinyl at R450 per square metre"}, False, lambda r: isinstance(r, list) and len(r) >= 1 and "450" in low(r)),
 ("U13", "extractGoodsReceived", {"text": "Received 10 sheets of plywood from Timber Supplies", "poLineItems": [{"description": "Plywood 18mm", "quantity_ordered": 10, "unit": "sheet"}]}, True,
   lambda r: "timber" in low((r or {}).get("supplier_name")) and len((r or {}).get("line_items") or []) >= 1),
 ("U14", "splitIntoTopics", {"text": "Mokoena paid me five hundred rand. Also order ten sheets of plywood for the Naidoo job."}, False, lambda r: isinstance(r, list) and len(r) >= 2),
]
def main():
    st0 = call("status-start", "GET", "/admin/engine/status")[1]
    if st0.get("mode") != "engine": call("provision", "POST", "/admin/engine/provision-sample", {"confirm": BIZ})
    ctx["st0"] = call("status-before", "GET", "/admin/engine/status")[1]
    for cid, fn, args, records, check in CASES:
        code, d = call("probe-" + cid, "POST", "/debug/extract-probe", {"fn": fn, "args": args})
        try: ok = bool(code == 200 and d.get("via") and check(d.get("result")))
        except Exception: ok = False
        results.append({"id": cid, "set": "understanding", "fn": fn, "records_route": records, "http": code, "route": d.get("route"), "via": d.get("via"), "why": d.get("why"), "threw": d.get("threw"),
                        "result": json.dumps(d.get("result"), ensure_ascii=False)[:300], "ms": d.get("ms"), "passed": ok})
    bad_code, bad = call("probe-unknown", "POST", "/debug/extract-probe", {"fn": "storeUnscopedMemory", "args": {"text": "x"}})
    st1 = call("status-after", "GET", "/admin/engine/status")[1]
    ctx["inv"] = {
        "records_routes_never_went_to_moonshot": all(not str(r["via"] or "").startswith("moonshot") for r in results if r["records_route"]),
        "an_unknown_function_is_refused_422": bad_code == 422,
        "no_server_error_on_any_case": all(r["http"] < 500 and r["http"] != 0 for r in results),
        "the_probe_wrote_nothing": (ctx["st0"].get("hashes") or {}) == (st1.get("hashes") or {}) and bool(st1.get("hashes")),
    }
try: main()
except Exception:
    import traceback; crash = traceback.format_exc()[-1500:]
und = results; inv = ctx.get("inv", {})
und_ok = sum(1 for r in und if r["passed"]); need = 12
model_down = bool(results) and all(not r["via"] for r in results)
safety_ok = bool(inv) and all(inv.values())
out = {"when": datetime.datetime.now(datetime.timezone.utc).isoformat(), "run": RUN, "commit": os.environ.get("GITHUB_SHA", "")[:7], "mode": "extract-model-run", "business": BIZ,
       "model": "the router's routes (worker/src/model-routes.ts); each case records which model answered (via)",
       "understanding": {"passed": und_ok, "of": len(und), "needed": need}, "safety": {"invariants": inv},
       "via_counts": {v: sum(1 for r in results if (r["via"] or "none") == v) for v in sorted({(r["via"] or "none") for r in results})},
       "model_unavailable": model_down, "passed": (not model_down) and crash is None and safety_ok and len(und) == len(CASES) and und_ok >= need,
       "failed": [r["id"] for r in results if not r["passed"]] + [k for k, v in inv.items() if not v], "results": results, "samples": samples, "crash": crash}
print(json.dumps(out, indent=1))
