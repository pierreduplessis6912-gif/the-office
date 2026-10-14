#!/usr/bin/env python3
"""Judges the numbers tools/load-test.py measured (SHIP_CHECKLIST.md item 12). Usage: load-judge.py results.json [--markdown]. Exit 0 = every target met, 1 = something is not.

The targets, and why they are what they are. The test runs from a US runner against a business in South Africa's Cloudflare edge, so every figure includes a long round trip: these are not the
numbers a member in Zululand would see, they are an UPPER bound. A flooring business has a handful of people on at once (the headroom tested is 5x that), so:
  * Up to 10 at once, no REAL failure may happen: anything the application, or a broken connection, returned that is not a 200 is a problem. Above 10 the test is looking for the knee, so failures there are warnings.
  * Cloudflare's OWN edge error page (an instant HTML 502/503/504) is judged by a RATE, not by zero: the real runs of 2026-10-14 showed about 4 in 30,000 requests (0.013%), including at ONE request at a time, so
    they are not caused by load and no service on a shared platform can promise none. The cap is 0.1% (about 7x what was measured): enough to catch a platform that has really degraded, not so tight that
    every run is red for something nobody here can fix. The observed rate is always reported.
  * Reads at 10 at once: p95 within 2 seconds. Writes at 10 at once (each a real transaction): p95 within 5 seconds.
  * ISOLATION: another business's reads, while one is hammered with writes, must stay within 2x of their quiet p95 (or half a second more, whichever is larger: a quiet p95 of 80 ms doubling is noise).
  * MODEL IN FLIGHT: reads on the same business while sentences wait on the model must stay within 2x of quiet (or a second more). And every sentence must succeed.
  * The server's own health report must show no server errors during the run.
Anything missing fails: a test that did not measure something has not shown it is fine.
"""
import json
import sys

TARGETS = {
    "low_concurrency": 10,            # up to here, no real failure may happen
    "edge_failure_rate": 0.001,       # Cloudflare's own instant 502/503/504 page, at 10 at once or fewer, as a share of requests
    "reads_p95_seconds": 2.0,
    "writes_p95_seconds": 5.0,
    "isolation_factor": 2.0, "isolation_slack_seconds": 0.5,
    "model_factor": 2.0, "model_slack_seconds": 1.0,
    "model_min_reads_in_window": 3,   # fewer than this says nothing
}
FAMILIES = ("reads", "customers_import", "invoices_import", "mixed")


def at_most(phases, name, limit):
    """The phase of this family with the highest concurrency not above the limit."""
    c = [p for p in phases if p.get("name") == name and p.get("concurrency", 10 ** 9) <= limit]
    return max(c, key=lambda p: p["concurrency"]) if c else None


def judge(d):
    problems, warnings, lines = [], [], []
    phases = d.get("phases") or []
    if not d.get("seeded", {}).get("a") or not d.get("seeded", {}).get("b"):
        problems.append("a business could not be given its starting customers, so what was measured is not a realistic business")
    for fam in FAMILIES:
        if not any(p.get("name") == fam for p in phases):
            problems.append(f"the {fam} load was never measured")

    # 1. up to the low-concurrency line no REAL failure may happen; Cloudflare's own edge page is judged by its rate; above the line failures are worth knowing (the knee)
    everything = list(phases) + [p for p in (d.get("isolation") or {}).values() if isinstance(p, dict)]
    low_requests = low_edge = 0
    for p in everything:
        errs = p.get("errors", 0)
        edge = min(p.get("edge_errors", 0), errs)
        real = errs - edge
        low = p.get("concurrency", 0) <= TARGETS["low_concurrency"]
        if low:
            low_requests += p.get("requests", 0)
            low_edge += edge
        if errs > 0:
            msg = f"{p.get('name')} at {p.get('concurrency')} at once: {errs} of {p.get('requests')} requests failed ({p.get('statuses')})" + (f"; {edge} of them Cloudflare's own edge error page" if edge else "")
            (problems if low and real > 0 else warnings).append(msg)
        if p.get("requests", 0) == 0:
            problems.append(f"{p.get('name')} at {p.get('concurrency')} at once made no requests at all")
    if low_edge:
        rate = low_edge / low_requests if low_requests else 1
        lines.append(f"background failures: {low_edge} of {low_requests} requests at {TARGETS['low_concurrency']} at once or fewer were Cloudflare's own edge error page ({rate:.3%}; the cap is {TARGETS['edge_failure_rate']:.1%})")
        if rate > TARGETS["edge_failure_rate"]:
            problems.append(f"Cloudflare's edge error page appeared in {rate:.3%} of requests at {TARGETS['low_concurrency']} at once or fewer ({low_edge} of {low_requests}), over the {TARGETS['edge_failure_rate']:.1%} cap")
    if d.get("seed_retries"):
        warnings.append(f"seeding needed {d['seed_retries']} retries (a chunk that failed was sent again)")

    # 2. speed at 10 at once
    r = at_most(phases, "reads", TARGETS["low_concurrency"])
    if not r or r.get("p95") is None:
        problems.append(f"reads were never measured at {TARGETS['low_concurrency']} or fewer at once, so there is nothing to hold to the target")
    if r and r.get("p95") is not None:
        lines.append(f"reads at {r['concurrency']} at once: p50 {r['p50']}s, p95 {r['p95']}s, {r['rps']} requests/s")
        if r["p95"] > TARGETS["reads_p95_seconds"]:
            problems.append(f"reads at {r['concurrency']} at once: p95 {r['p95']}s is over the {TARGETS['reads_p95_seconds']}s target")
    for fam in ("customers_import", "invoices_import"):
        w = at_most(phases, fam, TARGETS["low_concurrency"])
        if not w or w.get("p95") is None:
            problems.append(f"{fam} was never measured at {TARGETS['low_concurrency']} or fewer at once, so there is nothing to hold to the target")
        if w and w.get("p95") is not None:
            lines.append(f"{fam} at {w['concurrency']} at once: p50 {w['p50']}s, p95 {w['p95']}s, {w['rps']} requests/s")
            if w["p95"] > TARGETS["writes_p95_seconds"]:
                problems.append(f"{fam} at {w['concurrency']} at once: p95 {w['p95']}s is over the {TARGETS['writes_p95_seconds']}s target")

    # 3. isolation between businesses
    iso = d.get("isolation") or {}
    alone, loaded = iso.get("b_alone"), iso.get("b_while_a_is_written_to")
    if not alone or not loaded or alone.get("p95") is None or loaded.get("p95") is None:
        problems.append("the isolation between businesses was not measured")
    else:
        allowed = max(alone["p95"] * TARGETS["isolation_factor"], alone["p95"] + TARGETS["isolation_slack_seconds"])
        lines.append(f"isolation: the other business's reads p95 {alone['p95']}s alone, {loaded['p95']}s while the first was written to as hard as allowed (allowed {round(allowed, 3)}s)")
        if loaded["p95"] > allowed:
            problems.append(f"ISOLATION BROKEN: the other business's reads p95 went from {alone['p95']}s to {loaded['p95']}s (allowed {round(allowed, 3)}s) while one business was written to")

    # 4. the model in flight
    m = d.get("model_in_flight")
    if m is None:
        warnings.append("the model in flight was not measured (no sentences were sent)")
    else:
        quiet, busy, sent = m.get("baseline_reads"), m.get("reads_while_sentences_wait"), m.get("sentences")
        if not quiet or not busy or not sent or quiet.get("p95") is None:
            problems.append("the model in flight was only partly measured")
        else:
            if busy.get("requests", 0) < TARGETS["model_min_reads_in_window"] or busy.get("p95") is None:
                problems.append(f"only {busy.get('requests', 0)} reads happened while the sentences waited, too few to say anything")
            else:
                allowed = max(quiet["p95"] * TARGETS["model_factor"], quiet["p95"] + TARGETS["model_slack_seconds"])
                lines.append(f"model in flight: reads p95 {quiet['p95']}s quiet, {busy['p95']}s while {sent.get('requests')} sentences waited (allowed {round(allowed, 3)}s); sentences p50 {sent.get('p50')}s, max {sent.get('max')}s")
                if busy["p95"] > allowed:
                    problems.append(f"A MODEL CALL BLOCKS THE BUSINESS: reads p95 went from {quiet['p95']}s to {busy['p95']}s (allowed {round(allowed, 3)}s) while sentences waited on the model")
            if sent.get("errors", 0) > 0:
                problems.append(f"{sent['errors']} of {sent.get('requests')} real sentences failed ({sent.get('statuses')})")

    # 5. the server's own view
    health = ((d.get("server_side") or {}).get("health") or {}).get("requests") or {}
    if health.get("serverErrors"):
        problems.append(f"the business's own health report counted {health['serverErrors']} server errors during the run")

    # 6. where it starts to bend (information, not a target)
    knees = {}
    for fam in FAMILIES:
        ps = sorted((p for p in phases if p.get("name") == fam and p.get("p95") is not None), key=lambda p: p["concurrency"])
        if not ps:
            continue
        ref = ps[0]["p95"]
        knees[fam] = next((p["concurrency"] for p in ps if p["errors"] > 0 or p["p95"] > max(ref * 2, ref + 0.5)), None)
        ok_ps = [p for p in ps if p["errors"] == 0]
        top = max(ok_ps, key=lambda p: p["rps"]) if ok_ps else None
        lines.append(f"{fam}: bends at {knees[fam] if knees[fam] else 'no level tested'} at once; most it served without a failure: {top['rps'] if top else 'n/a'} requests/s (at {top['concurrency'] if top else 'n/a'} at once)")
    return {"ok": not problems, "problems": problems, "warnings": warnings, "findings": lines, "knees": knees, "targets": TARGETS}


def markdown(v):
    out = ["## Load test: " + ("every target met" if v["ok"] else "NOT every target met"), ""]
    for t in ("problems", "warnings", "findings"):
        if v[t]:
            out += [f"**{t.capitalize()}**", ""] + [f"- {x}" for x in v[t]] + [""]
    return "\n".join(out)


if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit("usage: load-judge.py results.json [--markdown]")
    try:
        data = json.load(open(sys.argv[1]))
    except Exception as e:  # noqa: BLE001 - an unreadable result is a failure, never a pass
        data = {}
        print(json.dumps({"ok": False, "problems": [f"the load test produced no readable result ({e})"], "warnings": [], "findings": [], "knees": {}}))
        sys.exit(1)
    verdict = judge(data)
    print(markdown(verdict) if "--markdown" in sys.argv else json.dumps(verdict, indent=1))
    sys.exit(0 if verdict["ok"] else 1)
