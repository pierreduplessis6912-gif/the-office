#!/usr/bin/env python3
# Probe of the Moonshot API with the repo secret MOONSHOT_API_KEY (never printed or recorded): which models the key can list, and one tiny timed request to each Kimi model.
# Records plain facts only in OUT: model ids, status, milliseconds, token usage, the first words of a one-sentence greeting, and error text if any. Run by .github/workflows/moonshot-probe.yml.
import json, os, sys, time, urllib.request, urllib.error
KEY = os.environ.get("MOONSHOT_API_KEY", ""); OUT = os.environ.get("OUT", "moonshot-probe.json"); BASE = "https://api.moonshot.ai/v1"
R = {"when": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "key_present": bool(KEY), "models_status": None, "models": [], "calls": []}
def call(method, path, body=None):
    req = urllib.request.Request(BASE + path, data=json.dumps(body).encode() if body is not None else None, method=method, headers={"Authorization": "Bearer " + KEY, "Content-Type": "application/json", "User-Agent": "moonshot-probe"})
    t = time.time()
    try:
        with urllib.request.urlopen(req, timeout=120) as r: status, text = r.status, r.read().decode()
    except urllib.error.HTTPError as e: status, text = e.code, e.read().decode()
    except Exception as e: return 0, {"error": str(e)[:160]}, int((time.time() - t) * 1000)
    ms = int((time.time() - t) * 1000)
    try: return status, json.loads(text), ms
    except Exception: return status, {"raw": text[:200]}, ms
if KEY:
    s, d, _ = call("GET", "/models"); R["models_status"] = s
    ids = sorted(m.get("id") for m in (d.get("data") or []) if isinstance(m, dict)) if isinstance(d, dict) else []
    R["models"] = ids
    if not ids and isinstance(d, dict): R["models_error"] = json.dumps(d)[:200]
    for mid in [i for i in ids if "kimi" in (i or "").lower()][:14]:
        for variant, extra in ([("low", {"reasoning_effort": "low"}), ("default", {})] if "k3" in mid else [("default", {}), ("thinking_disabled", {"thinking": {"type": "disabled"}})]):
            body = {"model": mid, "messages": [{"role": "user", "content": "Reply with one short sentence greeting."}], "max_completion_tokens": 400, **extra}
            s, d, ms = call("POST", "/chat/completions", body)
            msg = ((d.get("choices") or [{}])[0].get("message") or {}) if isinstance(d, dict) else {}
            R["calls"].append({"model": mid, "variant": variant, "status": s, "ms": ms, "usage": d.get("usage") if isinstance(d, dict) else None, "reply": (msg.get("content") or "")[:80], "has_reasoning": bool(msg.get("reasoning_content") or msg.get("reasoning")), "error": (json.dumps(d.get("error"))[:200] if isinstance(d, dict) and d.get("error") else None)})
json.dump(R, open(OUT, "w"), indent=1, ensure_ascii=False); open(OUT, "a").write("\n")
print("key present:", R["key_present"], "| models listed:", len(R["models"]), "| calls:", len(R["calls"]))
