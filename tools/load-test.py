#!/usr/bin/env python3
"""Load test for STAGING ONLY (SHIP_CHECKLIST.md item 12). It MEASURES; tools/load-judge.py decides.

What it asks, in the order it asks it:
  1. How fast are reads as more people read at once (a member's customer list), on a business with a realistic number of customers?
  2. How fast are WRITES as more people write at once? The writes are the two CSV imports: real routes, real member sessions, real transactions (item 9), and NO model, so they cost nothing.
  3. A mix of the two (8 reads to 2 writes), the way a working day looks.
  4. ISOLATION: while one business is hammered with writes, is ANOTHER business slowed? (Each business is its own Durable Object, so it should not be; this is the claim the architecture rests on.)
  5. MODEL IN FLIGHT: while a few real sentences wait on the model (seconds each), do reads on the SAME business stay fast? (A Durable Object runs one thing at a time between awaits; a model call is an await.)

Safety: it refuses any host but staging; it caps the real sentences (each costs a little); it never touches production. Every request carries a real member session, so the path measured is the one
members use: session check, directory lookup, the business's own object.
Environment: LOAD_HOST, COOKIE_A, COOKIE_B, ADMIN_KEY, LOAD_SECONDS (15), LOAD_STEPS ("1,5,10,25,50"), LOAD_SENTENCES (5, never more than 8), LOAD_MODEL_SECONDS (20).
LOAD_LOCAL_PORT is for the tests only: it points the script at a fake server on 127.0.0.1 over plain HTTP, and works for no other host.
"""
import http.client
import json
import math
import os
import random
import ssl
import sys
import threading
import time
import uuid

HOST = os.environ.get("LOAD_HOST", "")
LOCAL_PORT = os.environ.get("LOAD_LOCAL_PORT")
if LOCAL_PORT:
    if HOST != "127.0.0.1":
        sys.exit("LOAD_LOCAL_PORT works only with LOAD_HOST=127.0.0.1 (it exists for the tests)")
elif not (HOST.startswith("office-staging.") and HOST.endswith(".websitehub.co.za")):
    sys.exit("refusing to load test anything but staging (the host must be office-staging.<domain>.websitehub.co.za), got: " + repr(HOST))
COOKIE_A = os.environ.get("COOKIE_A", "")
COOKIE_B = os.environ.get("COOKIE_B", "")
ADMIN_KEY = os.environ.get("ADMIN_KEY", "")
SECONDS = float(os.environ.get("LOAD_SECONDS", "15"))
STEPS = sorted({int(x) for x in os.environ.get("LOAD_STEPS", "1,5,10,25,50").split(",") if x.strip()})
MODEL_SECONDS = float(os.environ.get("LOAD_MODEL_SECONDS", "20"))   # how long reads are timed while the sentences wait (a sentence takes several seconds)
SENTENCES = max(0, min(int(os.environ.get("LOAD_SENTENCES", "5")), 8))   # a hard ceiling: each real sentence costs a little
if not COOKIE_A or not COOKIE_B or not STEPS:
    sys.exit("COOKIE_A, COOKIE_B and LOAD_STEPS are required")


class Client:
    """One keep-alive connection, like one phone. A failure is recorded as status 0 and the connection is rebuilt."""

    def __init__(self):
        self.conn = None

    def request(self, method, path, headers=None, body=None):
        t = time.perf_counter()
        try:
            if self.conn is None:
                if LOCAL_PORT:
                    self.conn = http.client.HTTPConnection(HOST, int(LOCAL_PORT), timeout=90)
                else:
                    self.conn = http.client.HTTPSConnection(HOST, timeout=90, context=ssl.create_default_context())
            self.conn.request(method, path, body=body, headers=headers or {})
            r = self.conn.getresponse()
            data = r.read()
            return r.status, time.perf_counter() - t, data
        except Exception as e:  # noqa: BLE001 - any failure is a data point, not a crash
            try:
                self.conn.close()
            except Exception:  # noqa: BLE001
                pass
            self.conn = None
            return 0, time.perf_counter() - t, str(e).encode()[:200]


def percentile(sorted_values, p):
    if not sorted_values:
        return None
    return sorted_values[max(0, math.ceil(p * len(sorted_values)) - 1)]


def summarize(name, workers, elapsed, rows, **extra):
    """rows: (started_at, status, seconds). Errors are anything but a 200; their latencies are kept in the spread so a timeout shows."""
    lat = sorted(r[2] for r in rows)
    statuses = {}
    for r in rows:
        statuses[str(r[1])] = statuses.get(str(r[1]), 0) + 1
    ok = sorted(r[2] for r in rows if r[1] == 200)
    out = {
        "name": name, "concurrency": workers, "seconds": round(elapsed, 2), "requests": len(rows),
        "rps": round(len(rows) / elapsed, 2) if elapsed > 0 else 0, "statuses": statuses,
        "errors": sum(1 for r in rows if r[1] != 200),
        "p50": percentile(lat, 0.50), "p95": percentile(lat, 0.95), "p99": percentile(lat, 0.99), "max": lat[-1] if lat else None,
        "ok_p95": percentile(ok, 0.95),
    }
    out.update(extra)
    for k in ("p50", "p95", "p99", "max", "ok_p95"):
        if out[k] is not None:
            out[k] = round(out[k], 3)
    return out


def run_groups(groups, seconds):
    """groups: [(name, workers, make_op, once)]. All run at the same time until the same stop (a `once` group makes one request per worker). Returns {name: (rows, elapsed)}."""
    stop = time.perf_counter() + seconds
    rows = {g[0]: [] for g in groups}
    started = time.perf_counter()
    threads = []

    def work(name, i, make_op, once):
        c = Client()
        n = 0
        while True:
            t0 = time.perf_counter()
            if not once and t0 >= stop:
                break
            status, secs, _ = make_op(i, n)(c)
            rows[name].append((t0, status, secs))
            n += 1
            if once:
                break

    for name, workers, make_op, once in groups:
        for i in range(workers):
            th = threading.Thread(target=work, args=(name, i, make_op, once), daemon=True)
            threads.append(th)
            th.start()
    for th in threads:
        th.join()
    elapsed = time.perf_counter() - started
    return {name: (r, elapsed) for name, r in rows.items()}


def phase(name, workers, make_op, **extra):
    res = run_groups([(name, workers, make_op, False)], SECONDS)
    rows, elapsed = res[name]
    return summarize(name, workers, elapsed, rows, **extra)


def multipart(field, filename, text):
    boundary = "----load" + uuid.uuid4().hex
    body = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"{field}\"; filename=\"{filename}\"\r\nContent-Type: text/csv\r\n\r\n{text}\r\n--{boundary}--\r\n").encode()
    return body, {"Content-Type": "multipart/form-data; boundary=" + boundary}


def read_op(cookie):
    return lambda i, n: (lambda c: c.request("GET", "/customers", {"Cookie": cookie}))


def customers_import_op(cookie):
    def make(i, n):
        def op(c):
            names = "\n".join("Load " + uuid.uuid4().hex[:10] for _ in range(3))
            body, h = multipart("csv", "load.csv", "name\n" + names + "\n")
            return c.request("POST", "/files/customers-csv-import", {"Cookie": cookie, **h}, body)
        return op
    return make


def invoices_import_op(cookie):
    def make(i, n):
        def op(c):
            rows = "".join(f"L-{uuid.uuid4().hex[:8]},2026-10-14,Load Client {k},100.00,100.00,0.00,\n" for k in (1, 2, 3))
            body, h = multipart("csv", "load-invoices.csv", "Invoice,Date,Client,Total,Paid,Balance due,Payment details\n" + rows)
            return c.request("POST", "/files/invoices-csv-import", {"Cookie": cookie, **h}, body)
        return op
    return make


def mixed_op(cookie):
    reads, writes = read_op(cookie), customers_import_op(cookie)
    return lambda i, n: (reads(i, n) if random.random() < 0.8 else writes(i, n))


def sentence_op(cookie):
    def make(i, n):
        def op(c):
            body = json.dumps({"text": f"Invoice Staging Customer One R1500 for load test job {uuid.uuid4().hex[:6]}"}).encode()
            return c.request("POST", "/messages/text", {"Cookie": cookie, "Content-Type": "application/json"}, body)
        return op
    return make


def customer_count(cookie):
    status, _, data = Client().request("GET", "/customers", {"Cookie": cookie})
    try:
        return len(json.loads(data).get("items", [])) if status == 200 else None
    except Exception:  # noqa: BLE001
        return None


def seed(cookie, total, label):
    """Give a business a realistic number of customers first (a flooring business has hundreds), 50 to a file."""
    c = Client()
    done = 0
    while done < total:
        names = "\n".join(f"{label} {done + k:04d}" for k in range(min(50, total - done)))
        body, h = multipart("csv", "seed.csv", "name\n" + names + "\n")
        status, _, _ = c.request("POST", "/files/customers-csv-import", {"Cookie": cookie, **h}, body)
        if status != 200:
            return False
        done += 50
    return True


def admin_get(path, business):
    status, _, data = Client().request("GET", path, {"X-Admin-Key": ADMIN_KEY, "X-Target-Business": business})
    try:
        parsed = json.loads(data)
    except Exception:  # noqa: BLE001
        return {"status": status, "unreadable": True}
    text = json.dumps(parsed)
    return parsed if len(text) < 20000 else {"status": status, "too_large_keys": list(parsed)[:20] if isinstance(parsed, dict) else None}


def main():
    out = {"when": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "host": HOST, "seconds_per_phase": SECONDS, "steps": STEPS, "phases": []}
    out["seeded"] = {"a": seed(COOKIE_A, 300, "Seed A"), "b": seed(COOKIE_B, 100, "Seed B")}
    out["customers_before_reads"] = customer_count(COOKIE_A)
    for w in STEPS:
        out["phases"].append(phase("reads", w, read_op(COOKIE_A)))
    for w in [w for w in STEPS if w <= 25] or STEPS[:1]:
        out["phases"].append(phase("customers_import", w, customers_import_op(COOKIE_A)))
    for w in [w for w in STEPS if w <= 10] or STEPS[:1]:
        out["phases"].append(phase("invoices_import", w, invoices_import_op(COOKIE_A)))
    for w in [w for w in STEPS if w in (10, 25)] or STEPS[-1:]:
        out["phases"].append(phase("mixed", w, mixed_op(COOKIE_A)))

    # Isolation: B alone, then B while A is written to as hard as it is allowed.
    b_readers, a_writers = min(5, max(STEPS)), min(25, max(STEPS))
    baseline = phase("isolation_b_alone", b_readers, read_op(COOKIE_B))
    res = run_groups([("a_writes", a_writers, customers_import_op(COOKIE_A), False), ("b_reads", b_readers, read_op(COOKIE_B), False)], SECONDS)
    out["isolation"] = {
        "b_alone": baseline,
        "b_while_a_is_written_to": summarize("b_reads", b_readers, res["b_reads"][1], res["b_reads"][0]),
        "a_writes": summarize("a_writes", a_writers, res["a_writes"][1], res["a_writes"][0]),
    }

    # The model in flight: reads on A with nothing happening, then reads on A WHILE sentences wait on the model (only the reads inside that window count).
    out["model_in_flight"] = None
    if SENTENCES > 0:
        readers = min(5, max(STEPS))
        quiet = phase("model_baseline_reads", readers, read_op(COOKIE_A))
        res = run_groups([("sentences", SENTENCES, sentence_op(COOKIE_A), True), ("reads", readers, read_op(COOKIE_A), False)], max(SECONDS, MODEL_SECONDS))
        s_rows = res["sentences"][0]
        t_from = min((r[0] for r in s_rows), default=0)
        t_to = max((r[0] + r[2] for r in s_rows), default=0)
        inside = [r for r in res["reads"][0] if t_from <= r[0] <= t_to]
        out["model_in_flight"] = {
            "baseline_reads": quiet,
            "reads_while_sentences_wait": summarize("reads_in_flight", readers, max(t_to - t_from, 0.001), inside, window_seconds=round(t_to - t_from, 2)),
            "sentences": summarize("sentences", SENTENCES, res["sentences"][1], s_rows),
        }

    out["server_side"] = {"timings": admin_get("/debug/timings", "staging-co"), "health": admin_get("/admin/health", "staging-co")}
    print(json.dumps(out, indent=1))


if __name__ == "__main__":
    main()
