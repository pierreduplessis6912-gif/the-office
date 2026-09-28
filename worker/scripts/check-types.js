#!/usr/bin/env node
// Real typecheck gate, per direct instruction, part of the security
// checklist's "next engineering phase" tier — this project had no
// automated check of any kind before tonight.
//
// Does not require a clean tsc pass to merge — the codebase's real,
// current baseline is 38 known, tolerated errors (mostly Workers AI
// binding calls typed as Record<string, unknown> across many
// different models, and a couple of real but low-stakes union-type
// looseness spots — see baseline-typecheck-errors.txt for the exact,
// current list). What actually matters, and what this enforces: no
// NEW error may be introduced without either being fixed or, if it is
// genuinely another instance of an already-tolerated category, added
// to the baseline deliberately, by name, in the same change.
//
// This is not a formality. Run once against the real code tonight, it
// caught two genuine, live bugs before they reached this list at all:
// a ReferenceError-in-waiting (a const declared in one branch, used
// outside both), and a missing import. Both are already fixed — this
// script is what stops the next one from being silent.
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const baselinePath = path.join(__dirname, "..", "baseline-typecheck-errors.txt");
const baseline = new Set(
  fs.existsSync(baselinePath)
    ? fs.readFileSync(baselinePath, "utf8").split("\n").map((l) => l.trim()).filter(Boolean)
    : []
);

let raw;
try {
  raw = execSync("npx tsc -p tsconfig.json", { cwd: path.join(__dirname, ".."), encoding: "utf8" });
} catch (err) {
  raw = err.stdout || "";
}

// Normalize away line/column numbers so an unrelated edit that shifts
// a later line doesn't spuriously look like a new error, or hide a
// real one at the same message but a different location.
const current = raw
  .split("\n")
  .filter((l) => l.includes("error TS"))
  .map((l) => l.replace(/\(\d+,\d+\)/, "").trim())
  .filter(Boolean);

const currentSet = new Set(current);
const newErrors = current.filter((l) => !baseline.has(l));
const fixedErrors = [...baseline].filter((l) => !currentSet.has(l));

if (fixedErrors.length > 0) {
  console.log(`${fixedErrors.length} previously-tolerated error(s) no longer occur — consider removing from the baseline:`);
  fixedErrors.forEach((l) => console.log("  " + l));
}

if (newErrors.length > 0) {
  console.error(`\n${newErrors.length} NEW type error(s), not in the baseline:\n`);
  newErrors.forEach((l) => console.error("  " + l));
  console.error(
    "\nEither fix the real issue, or — only if this is genuinely another instance of an\n" +
    "already-tolerated category — add the exact normalized line to worker/baseline-typecheck-errors.txt\n" +
    "in the same change, so the reason it is tolerated is reviewed alongside the code that needs it."
  );
  process.exit(1);
}

console.log(`Typecheck clean: ${current.length} known, tolerated error(s), 0 new.`);
