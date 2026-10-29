#!/usr/bin/env python3
# NAME GUARD SMOKE (IDENTITY_ARCHITECTURE.md, "A near-match customer name is asked, not matched"): the real model's extraction and every outcome of the near-match customer question, against STAGING with synthetic names.
# Picks names whose words appear in NO existing customer (read from the Office's own /customers), creates one customer, then says a near-match name and answers the question every way: forget it, the same one, a new customer, neither with an
# existing name, neither with a brand new name; also an exact repeat, a lookup and a measurement (a record that is not held). Every payment it holds is rejected afterwards. Staging credentials only, never production.
import base64, hashlib, hmac, json, os, re, sys, time, urllib.request, urllib.error
BASE = os.environ.get("BASE", "https://office-staging.websitehub.co.za").rstrip("/"); SEED = os.environ["SEED"]; OUT = os.environ.get("OUT", "name-guard-smoke.json")
BUSINESS = "staging-co"; OWNER = "staging-owner@example.com"
def derive(l): return re.sub(r"[=+/\n]", "", base64.b64encode(hmac.new(SEED.encode(), l.encode(), hashlib.sha256).digest()).decode())[:43]
def cookie():
    b = lambda x: base64.urlsafe_b64encode(x).rstrip(b"=").decode(); p = b(json.dumps({"email": OWNER, "exp": int(time.time() * 1000) + 3 * 3600000, "b": BUSINESS}, separators=(",", ":")).encode())
    return "office_session=" + p + "." + b(hmac.new(derive("session").encode(), p.encode(), hashlib.sha256).digest())
COOKIE = cookie()
def call(method, path, body=None):
    req = urllib.request.Request(BASE + path, data=json.dumps(body).encode() if body is not None else None, method=method, headers={"Content-Type": "application/json", "User-Agent": "name-guard-smoke", "Cookie": COOKIE})
    t = time.time()
    try:
        with urllib.request.urlopen(req, timeout=150) as r: s, tx = r.status, r.read().decode()
    except urllib.error.HTTPError as e: s, tx = e.code, e.read().decode()
    except Exception as e: return 0, {"error": str(e)[:120]}, int((time.time() - t) * 1000)
    ms = int((time.time() - t) * 1000)
    try: return s, json.loads(tx), ms
    except Exception: return s, {"raw": tx[:300]}, ms
FIRST = ["Zanele", "Thabo", "Naledi", "Sipho", "Lindiwe", "Mandla", "Nomsa", "Kagiso", "Palesa", "Tumelo", "Refilwe", "Bheki"]
MID = ["Pieter", "Hendrik", "Willem", "Johan", "Jacobus", "Andries", "Stephanus", "Gideon", "Marthinus", "Christiaan", "Daniel", "Frederik"]
LAST = ["Mokoena", "Dlamini", "Nkosi", "Pretorius", "Venter", "Naidoo", "Khumalo", "Mahlangu", "Steyn", "Ndlovu", "Cele", "Zulu"]
s, cs, _ = call("GET", "/customers"); existing = json.dumps(cs).lower()
rid = int(os.environ.get("GITHUB_RUN_ID", "0") or 0)
def pick():
    for n in range(144):
        f, l = FIRST[(rid + n) % 12], LAST[(rid // 3 + n) % 12]
        if f.lower() not in existing and l.lower() not in existing: return f, l
    return FIRST[rid % 12], LAST[(rid // 3) % 12]
F, L = pick(); M = [MID[(rid + k) % 12] for k in range(6)]
EXISTING = f"{F} {M[0]} {L}"; NEAR = [f"{F} {M[k]} {L}" for k in range(1, 6)]; BRAND = f"{FIRST[(rid + 5) % 12]} {MID[(rid + 7) % 12]} {LAST[(rid + 9) % 12]}"
R = {"when": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "target": BASE, "run": os.environ.get("GITHUB_RUN_ID"), "existing": EXISTING, "near": NEAR, "brand_new": BRAND, "steps": []}
s, h, _ = call("GET", "/health"); R["deployed_commit"] = h.get("commit") if isinstance(h, dict) else None
held = []
def say(text):
    s, b, ms = call("POST", "/messages/text", {"text": text}); b = b if isinstance(b, dict) else {}
    if b.get("pendingActionId") is not None and b.get("pendingActionType") in ("payment", None): held.append(b["pendingActionId"])
    return b, ms
def step(name, ok, **kw): R["steps"].append({"step": name, "ok": bool(ok), **kw}); return ok
# 0. a customer that exists (created by a payment, then confirmed)
b, _ = say(f"{EXISTING} paid R100"); aid = b.get("pendingActionId")
if aid is not None:
    s, c, _ = call("POST", f"/actions/{aid}/confirm", {})
step("0 existing customer created", aid is not None and "Payment noted" in (b.get("message") or ""), reply=b.get("message"), extracted_ok=EXISTING in (b.get("message") or ""))
# 1. a near-match name is ASKED
b, ms = say(f"{NEAR[0]} paid R200"); q1 = b.get("pendingActionId")
asked = b.get("pendingActionType") == "ambiguous_person" and any(EXISTING == (c.get("name")) for c in (b.get("pendingCandidates") or []))
step("1 near match is asked, not matched", asked, reply=b.get("message"), type=b.get("pendingActionType"), candidates=b.get("pendingCandidates"), ms=ms)
s, pend, _ = call("GET", "/embers/pending"); step("1b only the question is open (no payment held yet)", asked and not any(("payment" in json.dumps(p).lower() and NEAR[0].lower() in json.dumps(p).lower()) for p in (pend.get("pending", []) if isinstance(pend, dict) else [])), pending_count=len(pend.get("pending", [])) if isinstance(pend, dict) else None)
# 2. neither: forget it
if q1 is not None:
    s, d, _ = call("POST", f"/actions/{q1}/correct", {"discard": True}); step("2 forget it records nothing and says so", s == 200 and "nothing was recorded" in (d.get("message") or "").lower(), status=s, reply=d.get("message"))
    s, again, _ = call("POST", f"/actions/{q1}/correct", {"name": BRAND}); step("2b the answered question cannot be answered again", s == 409, status=s, body=again)
# 3. the same one
b, _ = say(f"{NEAR[1]} paid R300"); q = b.get("pendingActionId")
if q is not None:
    s, d, _ = call("POST", f"/actions/{q}/confirm", {}); msg = d.get("message") or ""
    if d.get("pendingActionId") is not None: held.append(d["pendingActionId"])
    step("3 the same one: the payment goes to the existing customer", s == 200 and f"Payment noted for {EXISTING}" in msg, status=s, reply=msg)
else: step("3 the same one", False, reply=b.get("message"))
# 4. a new customer
b, _ = say(f"{NEAR[2]} paid R300"); q = b.get("pendingActionId")
if q is not None:
    s, d, _ = call("POST", f"/actions/{q}/reject", {}); msg = d.get("message") or ""
    if d.get("pendingActionId") is not None: held.append(d["pendingActionId"])
    step("4 a new customer: made as spoken", s == 200 and f"Payment noted for {NEAR[2]}" in msg, status=s, reply=msg)
else: step("4 a new customer", False, reply=b.get("message"))
# 5. neither, an existing name
b, _ = say(f"{NEAR[3]} paid R300"); q = b.get("pendingActionId")
if q is not None:
    s, d, _ = call("POST", f"/actions/{q}/correct", {"name": EXISTING}); msg = d.get("message") or ""
    if d.get("pendingActionId") is not None: held.append(d["pendingActionId"])
    step("5 neither: corrected to an existing customer", s == 200 and d.get("status") == "corrected" and f"Payment noted for {EXISTING}" in msg, status=s, reply=msg)
else: step("5 neither, existing", False, reply=b.get("message"))
# 6. neither, a brand new name
b, _ = say(f"{NEAR[4]} paid R300"); q = b.get("pendingActionId")
if q is not None:
    s, d, _ = call("POST", f"/actions/{q}/correct", {"name": BRAND}); msg = d.get("message") or ""
    if d.get("pendingActionId") is not None: held.append(d["pendingActionId"])
    step("6 neither: corrected to a brand new name", s == 200 and d.get("status") == "corrected" and f"Payment noted for {BRAND}" in msg, status=s, reply=msg)
else: step("6 neither, brand new", False, reply=b.get("message"))
# 7. an exact repeat is not asked
b, _ = say(f"{EXISTING} paid R400"); step("7 the exact name is not asked about", b.get("pendingActionType") == "payment" and f"Payment noted for {EXISTING}" in (b.get("message") or ""), reply=b.get("message"), type=b.get("pendingActionType"))
# 8. a lookup is not asked
b, _ = say(f"How much does {NEAR[0]} owe?"); step("8 a lookup is never asked", b.get("pendingActionType") != "ambiguous_person", reply=(b.get("message") or "")[:160])
# 9. a record that is NOT held (a measurement) is asked about too
b, _ = say(f"Measure {NEAR[0]}'s lounge, it is 6 metres by 4 metres"); step("9 a measurement for a near-match name is asked about, not written", b.get("pendingActionType") == "ambiguous_person", reply=b.get("message"), type=b.get("pendingActionType"))
if b.get("pendingActionId") is not None: call("POST", f"/actions/{b['pendingActionId']}/correct", {"discard": True})
# cleanup: reject every payment hold this run created (and any left-over question)
for a in held: call("POST", f"/actions/{a}/reject", {})
R["summary"] = {"steps": len(R["steps"]), "ok": sum(1 for x in R["steps"] if x["ok"]), "failed": [x["step"] for x in R["steps"] if not x["ok"]]}
json.dump(R, open(OUT, "w"), indent=1, ensure_ascii=False); open(OUT, "a").write("\n")
print(R["summary"])
