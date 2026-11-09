> **Status:** proposed. **Verified:** not yet. **Owns:** none.

# DECISIONS: snapshot-size-scoping

Written 2026-11-09 by the build chat. A SCOPE FOR REVIEW: it authorises nothing and no code. Evidence labels: [C] code read, [T] test, [X] committed staging record, [I] inference, [U] unknown. Background: the memory ramp found the edge (`docs/decisions/engine-foundation.md`, "The memory ramp: the edge was found"): on a real Durable Object a single table of about 108-byte rows snapshots and restores at 170,000 rows (18.4 MB of text) and its SNAPSHOT fails at 180,000 rows (19.5 MB) with Cloudflare error 1101 after under two seconds [X].

## Why it fails where it does [C]
`takeSnapshot` (`worker/src/backup.ts`) reads one table at a time in pages of 500 rows, but keeps EVERY row of that table as a JSON string in one array, then joins them into one big string, then gzips that into a third buffer, then uploads it. So the peak is a few copies of the table's JSON at once, which matches the ramp's edge being about 6 to 7 times the table's size against the 128 MB limit [I]. A restore downloads the parts up front but gunzips and inserts one table at a time, page by page [C]; it has not been tried past 170,000 rows because the snapshot fails first.

## What the limit means in practice
- It is the BYTES of the largest single table, not a row count: rows of about 1 KB would reach it at about 18,000 rows [I].
- Nothing monitors per-table size: the health report has no such measure [C]. A business that grows past the edge finds out when its snapshot fails (and the object restarts), not before.
- The legacy tables a business could grow fastest are the logs and captures [I]; whether any real business is near it is unknown [U] (no production measurement has been made).

## Options
| Option | What it is | For | Against |
|---|---|---|---|
| 1 (recommended first) | A size GUARD and a size MEASURE, no change to the snapshot format: report each table's size (an estimate from its row count and a sample of row length, so no full scan) in the backup status and the health report, and have `takeSnapshot` refuse early with a clear named error when a table is above a safe cap (about half the edge, roughly 9 MB) instead of running the object out of memory | Small, read-only measure, no format or restore change, turns a surprise into a signal and stops a failing snapshot from resetting the object | Does not raise the limit: an oversize business still cannot be backed up until it is trimmed or option 2 or 3 exists |
| 2 | CHUNK each table into several parts (for example 20,000 rows or 4 MB each) with the manifest listing the parts; restore reads them in order | Removes the per-table limit (storage bounds it, not memory) | A new manifest version, changes to the validator, the snapshot, the restore and every proof of them; it is the recovery path, so it needs the rehearsal and restore proofs run again and the recovery gate's acceptance |
| 3 | STREAM the table into the compressor page by page without keeping the lines array or the joined string | Same format, no manifest change; probably moves the edge up a few times [I] | Still bounded (by the compressor's buffer); a smaller win than 2; still touches the snapshot code |

## Recommendation
Option 1 now, because it is cheap and safe and it makes the limit visible; then decide between 2 and 3 with the recovery gate, since both change the recovery path. Option 1's cap is a judgement [I]: the ramp's own numbers (passes at 18.4 MB, fails at 19.5 MB) say a cap of about half leaves room for a different row shape.

## What option 1 would need (not started)
`worker/src/backup.ts` (the cap and the early refusal), `worker/src/migration.ts` (a per-table size estimate beside `tableInfo`), `worker/src/health.ts` (report it), tests first (a table over the cap is refused with the named error and nothing is uploaded; a table under it is unchanged; the estimate is within a stated tolerance; the existing backup and restore suites unchanged), and a staging check that reuses the ramp (a table above the cap is refused, one below it still snapshots and restores). These are legacy backup files, so the recorded legacy behaviour tests must still pass untouched. **Questions for Pierre:** (1) is option 1 first the right order? (2) is a cap of about half the edge (roughly 9 MB) right, or do you want it nearer the edge? (3) should 2 or 3 be scoped further now or only with the recovery gate?
