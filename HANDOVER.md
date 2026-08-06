# The Office — New Session Handover Brief

Written because a real, practical problem came up: context window limits
being hit even without substantial new builds happening in a session.
This is meant to let a fresh chat pick up and operate exactly as this
one has, without re-deriving the working method from scratch.

Paste this whole file's content, or a link to it, as the first message
in a new session, along with the GitHub token (deliberately **not**
included here — this repo is public, and a token permanently in a
public repo's file history is real exposure. Get the token from
Pierre directly at session start).

---

## What this project is

The Office — a voice-first AI business assistant for tradespeople,
built for Pierre's own flooring/blinds business first, with
"Peter" (a plumber, working in noisy, hands-on environments) as the
named persona representing the eventual "million Peters" who might
use this. Cloudflare Workers/D1/KV/Vectorize/R2 backend, Flutter
mobile app (Android native + web preview for fast iteration).

Repo: `pierreduplessis6912-gif/the-office` (public).
Worker API: `https://office.websitehub.co.za`
Web preview: `https://the-office-preview.pages.dev`
A/B experiment preview (separate, isolated): `https://the-office-ab-experiment.pages.dev`

## Access needed at session start

- **GitHub personal access token** — for reading/writing repo files
  via the GitHub Contents API and polling GitHub Actions run status.
  Ask Pierre for this directly; do not expect it to be anywhere in
  the repo itself.
- Cloudflare deploy credentials are **already configured** as GitHub
  Actions secrets (`CF_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`) — no
  direct Cloudflare access needed, deploys happen through the
  existing workflows.

## Read these first, in this order

1. **`OFFICE_CONSTITUTION.md`** — the backend's governing doctrine:
   named principles, the Execution Ladder, the Patient Prospector
   pattern, the five-domain lens (Communication/Knowledge/Activity/
   Commerce/Governance).
2. **`STATUS.md`** — authoritative backend "where things actually
   stand." Trust this over any memory of past conversations if they
   conflict. Its own header is honest that frontend/app state is
   tracked separately (see next).
3. **`DECISIONS.md`** — the full, real narrative history: every
   notable bug, every architectural decision, why. ~4,200+ lines.
   Read the most recent entries first for immediate context; older
   entries for deep history on a specific area if needed.
4. **The four Flutter/design governance docs, in this order**:
   `EXPERIENCE_BRIEF.md` (the emotional core — "relief, not
   productivity"), `ether-manifesto.html` (voice-first design
   manifesto), `DESIGN_CONSTITUTION_V2.md` (real, numbered rules —
   the void is sacred, embers are subconscious, motion is weather not
   theatre, drawers are rooms), `NATIVE_TRANSITION_BRIEF.md` (native
   Android first, Impeller, judge feel on the real device not the web
   preview).
5. **`OFFICE_RUNTIME_V1.md`** — the current architecture direction.
   Status: **built and verified**, not just planned — real clock,
   state machine, event bus, three visual systems migrated onto it,
   one real capability (People) proven against the room pattern.
6. **`OFFICE_MOODBOARD.md`** — shared visual-language reference,
   real links with original rationale, not embedded images. **Has an
   unfinished edit in progress** — see "Immediate next step" below.

## Current state, honestly

**Solid, proven, not touched recently:** the backend — invoicing
chain, Snags, GRN routing, Leads, Supplier Statement Reconciliation,
`characters`/`customers` separation as a structural safety guarantee.

**Proven this session, hard-won:** full auth (bearer tokens, real
Google OAuth verified live), the native Android build pipeline after
three real, distinct debugging rounds (see `DECISIONS.md` for the
`path_provider_android` pin, Kotlin plugin version bump, `compileSdk`
subprojects-block fix — don't re-derive these from scratch, they're
already solved).

**Built and verified this session:** the Office Runtime — real,
shared `Ticker`-based clock (`lib/runtime/office_clock.dart`), real
state machine with all seven states genuinely wired to real moments
(`lib/runtime/office_state.dart`), real room materialization pattern
(`lib/runtime/office_room.dart`). Orb, all 5 embers, and the
decorative spark field all migrated onto the one shared clock — zero
independent `AnimationController`s left among them. People rebuilt as
the first real capability against "Current Capability." Verified on
the real native device, not just web preview — confirmed smoother,
animations deliberately unchanged (this was a migration, not a
redesign).

**Explored, not adopted:** `experiment/kimi-ab-test` branch — a
fragment-shader "Heat Orb" (turbulent noise field, no hard edge).
Real, working, deployed to its own isolated Cloudflare Pages project.
Never merged into `main`. Worth knowing it exists if the shader
approach is ever revisited.

**Explicitly deferred, on purpose, not forgotten:** words dissolving
into the void (Rule 3) — messages still permanently log via a plain
`ListView`. Only one real capability/room exists (People) — Quotes,
Invoices, Camera, Stock, Jobs are still the drawer's placeholder
items. The render pipeline as formally distinct, ordered layers is
still implicit in widget order. TTS/"Speaking" state — actively
considered and set aside (see `DECISIONS.md` — Voicebox repo
evaluated and rejected as architecturally mismatched, desktop vs.
mobile). Sound design — not started.

## Immediate next step (was mid-task when this session ended)

`OFFICE_MOODBOARD.md` was being updated with real, highly-relevant
finds from a designer's Dribbble portfolio
(`dribbble.com/madebylalit_`) — an entire body of work specifically
on AI-assistant motion design. Real shot links already identified,
not yet written into the document:

- `dribbble.com/shots/27621953-Ai-assistant-Thinking` — directly
  matches the existing Thinking state.
- `dribbble.com/shots/27477302-AI-Assistant` — tagged orb/sphere,
  matches Orb behaviour.
- `dribbble.com/shots/27473346-Ai-assistant-visual` — tagged
  orb/sphere/thinking.
- `dribbble.com/shots/27453999-AI-Assistant` — tagged
  speaking/thinking, possibly relevant to the still-empty Speech
  visualisation category.
- `dribbble.com/shots/27417571-Thinking` — dither animation, glyph,
  searching/thinking.
- `dribbble.com/shots/27407822-Interactive-ai-assistant-wip`.
- `dribbble.com/shots/27558235-Pixel-Motion`,
  `dribbble.com/shots/27494382-Apple-Pixel-Motion` — possibly
  relevant to Particles or Thinking-state visualization.
- `dribbble.com/shots/27571940-Loaders`,
  `dribbble.com/shots/27554718-Preloader` — worth including carefully
  if at all; DESIGN_CONSTITUTION_V2.md's Rule against spinners means
  these may be more useful as a "what to avoid" reference than a
  "steal this" one — worth deciding deliberately, not just adding by
  default.

Fetch the current `OFFICE_MOODBOARD.md` via the GitHub Contents API,
add these under the appropriate categories with original one-sentence
rationale each (what to steal, not a restatement of the shot's own
description), and push.

## The established working method — follow this exactly

**Every file edit follows this loop, no exceptions:**
1. Fetch the current file via GitHub Contents API (get its real,
   current SHA — never assume a stale local copy is current).
2. Edit locally (view/str_replace/create_file tools).
3. **Verify before pushing** — balance-check braces/parens/brackets
   for Dart edits at minimum; for anything with real logic risk
   (regex-based file patching, non-trivial control flow), actually
   test it locally against a realistic simulated input first. This
   caught real bugs before they ever reached a build, repeatedly.
4. Push via the Contents API with the real SHA and a real, honest
   commit message explaining *why*, not just *what*.
5. **Watch the actual build result** — poll
   `GET /repos/{owner}/{repo}/actions/runs?per_page=1` (filter by
   `&branch=X` for non-main branches), wait for `completed`, check
   `conclusion`. Never report success without having watched this.
6. **On failure**, get the actual failing step via
   `GET .../actions/runs/{id}/jobs` before guessing at a fix — raw
   logs aren't reachable from this sandbox (Azure blob storage host
   is blocked), so step names/conclusions plus direct reasoning about
   the actual diff is the real diagnostic method, not speculation.

**Real, hard-won gotchas already solved — don't rediscover these:**
- `ChangeNotifier` lives in `package:flutter/foundation.dart`, not
  `scheduler.dart`.
- Flutter's `Stack` defaults to `Clip.hardEdge` — silently clips
  `OverflowBox`'s larger paint area unless `clipBehavior: Clip.none`
  is set explicitly, at every nesting level involved.
- `canvas.saveLayer()`'s `bounds` parameter should be generously
  sized — Flutter's own docs call it a compositor hint, not a
  strictly enforced clip, but it's safer to size it generously anyway.
- `path_provider_android` must stay pinned to `2.2.22` in
  `pubspec.yaml` (`dependency_overrides`) — newer versions introduced
  a `jni` dependency that breaks the native Android build.
- `compileSdk` override for third-party modules (file_picker, etc.)
  needs a root-level `subprojects { afterEvaluate { ... } }` block,
  not just an app-level override.
- Cloudflare Pages: a fresh project's real, Cloudflare-side
  production-branch setting doesn't get changed by re-running
  `wrangler pages project create` on an already-existing project
  (fails silently under `continue-on-error`) — pin `--branch`
  explicitly on the deploy step itself instead of relying on
  automatic git-branch detection, which can pick up "detached HEAD"
  in CI.
- `--web-renderer` was removed in Flutter 3.29 — CanvasKit is simply
  the default now; don't try to pass this flag.

**Principles that shape every decision, not just style rules:**
- Build only what's earned by real evidence — no speculative fields,
  no generic interfaces designed ahead of real examples to generalize
  from (see: why the capability layer is a single "Current
  Capability" slot, not a plugin framework, until several real
  capabilities exist).
- Real bugs come from real data — six real bugs this project has
  caught all came from dense, real-world input; synthetic test cases
  have been insufficient before.
- When multiple AI conversations (Kimi, ChatGPT, this one) each
  propose something, evaluate critically and specifically — adopt
  what's genuinely good, name what's disproportionate or conflicts
  with an existing decision, and say so plainly rather than agreeing
  by default. This project's real, best moments came from honest
  disagreement converging into something better than any single
  proposal, not from deference.
- Never claim a build succeeded without having watched the real
  result. Never guess at a bug's cause when the actual diff or a
  local test can confirm it directly.
- Write real decisions down as they happen (`DECISIONS.md`,
  `STATUS.md`, the relevant governance doc) — don't let real
  architectural or design decisions live only in chat history that a
  future session won't have access to. This document exists because
  that discipline was followed, and should keep being followed by
  whichever session reads it next.
