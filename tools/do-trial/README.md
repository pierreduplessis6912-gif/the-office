# Durable Object adapter trial (2026-10-12)

`worker/src/storage/do-d1.ts` lets the application talk to a Durable Object's own SQLite through the small slice of the D1 interface it uses.
Evidence that it behaves like D1 (see `DECISIONS.md`, "Database architecture"):

1. `HARNESS_BACKEND=do node tools/role-matrix.test.js` runs the WHOLE suite (every recording) through the adapter. CI runs it on every push.
2. `battery.ts` is a 24-point check of everything the code relies on. `tools/do-adapter.test.js` runs it against a stand-in for the Durable Object's storage and
   compares with `tools/golden/do-real-battery.json`, the answers the REAL Durable Object runtime gave (run with `run-real.mjs`, which needs `miniflare@4`).
3. `trial.ts` (admin routes `/debug/trial-d1` and `/debug/trial-do`) measures the real latency difference from a phone.
