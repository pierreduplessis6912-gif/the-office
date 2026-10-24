> **Status:** real. **Verified:** not yet. **Owns:** none.

# DECISIONS: app-and-experience

Part of [DECISIONS.md](../../DECISIONS.md), split from it on 2026-10-24 without changing a word (the original is `git show 95bf743:DECISIONS.md`). Sections keep their original order.

## UX vision — the Ether, and what it does / doesn't change (2026-07-10)

A design manifesto ("The Ether") and a business-philosophy vision doc were
reviewed against this file directly, on purpose, to test which parts are
already earned by the real backend and which parts would reopen settled
decisions. Conclusion: **architecture and UX have deliberately been kept
separate throughout this build, and most of the vision holds without moving
architecture at all.**

- **"Askable, not searchable."** Two genuinely different things travel under
  this phrase, and only one is a new capability:
  - *Canonical facts rendered as affordances* ("phone James" → tappable
    contact card, "WhatsApp James" → prepopulated message) is a client
    rendering decision on data that's already correct — `customer_facts`
    already stores `phone_number`/`email`/`address` under closed, consistent
    keys, already normalized via `libphonenumber-js`. No backend work
    implied; this is UI work on top of what already exists.
  - *Conversational, multi-turn retrieval depth* — asking a question, then
    drilling into the answer two or three more turns deep with pronouns and
    references ("who did we deal with in those instances?" / "when was
    that?"). **Proven live 2026-07-10** with the exact scenario named here
    (why don't we buy from ProSupply anymore → who did we deal with → when
    was that), all three hops landing on the correct fact. Not via
    `rewriteQuery`, which this same testing found and replaced — see the
    Extraction schema section above for the real mechanism
    (`resolveFollowUpEntity`) and the five failed attempts that preceded it.
- **Reports/exports on demand** (a conversation compiled into a document)
  are confirmed to be the same category as invoice/quotation PDFs — an
  output layer built on top of retrieval, not a prerequisite for it. Not
  prioritized ahead of retrieval depth itself.
- **The ambient "briefing card" / ambient emotional state (the sigh, red ↔
  green cognitive-load indicator, unprompted "3 things need your
  attention")** was explicitly *not* the same as conversational retrieval —
  it's push, not pull, and it directly re-raised the periodic-briefing
  question already decided against once ("Known gaps": deliberately not
  built as a cron-generated snapshot, named as unearned complexity). Real,
  demonstrated need had been the bar for every other build decision here
  (the receptacle, work observations, `withRetry`, thinking-mode for
  rewrites) — this was the first idea on the roadmap with no such evidence
  and, by its own nature (an ambient/automatic layer), couldn't
  straightforwardly generate the kind of evidence a bug or a lost
  measurement does. Deliberately held apart from "deferred pending
  evidence": deferred pending a real design decision about tone and
  control, to be made on purpose, not backed into. **That decision was
  made 2026-07-10 — see the section immediately below.** Resolved as
  "notification embers," not the original briefing-card shape.

## Room visualizers — a real, evidence-based answer, not a speculative one (2026-07-19)

**The open question, closed with actual research rather than left as a
guess.** Discussing what "The Office" should and shouldn't cover
raised whether a room/floor visualizer belongs in scope. Checked
directly rather than assumed: Belgotex has no visualizer anywhere on
its site. Azura has a real "Room Visualizer / Floor Visualiser / Rug
Visualiser." Finfloor has one too — and fetching the actual page
directly (not just a search summary) revealed the decisive detail: it
isn't custom-built. The page literally announces launching Roomvo, a
third-party visualization platform, and the button on the page calls
`roomvo.startStandaloneVisualizer()` directly.

**Sharper still: both Finfloor and Azura actively encourage flooring
*contractors* — not just their own retail sites — to embed their
licensed visualizer on the contractor's own website.** A real,
practical, near-term opportunity worth acting on independent of
anything here: Zululand Flooring likely already qualifies for one of
these, free or near-free, through its existing supplier relationships.

**A real correction to the reasoning, made the same session — the
original conclusion had the wrong justification underneath it.** The
actual point being made wasn't "contractors already have their own
websites to embed this on." Many don't — a real, common case, not an
edge one. The actual goal is sharper on-site decisions, standing in the
customer's room, with no website involved on either side. That's a
different, better question, and it changes what's worth checking.

**Checked directly, honestly, rather than assumed either way: no
confirmed evidence exists that Roomvo (or similar platforms) offers a
real API for a third-party *app* to integrate with directly.** Their
actual integrations are website/e-commerce platforms (Shopify,
Magento) — their product is fundamentally a website-embed tool, not an
API-first service for someone else's app to call. Worth being honest
about this as a real limitation rather than assuming integration is
possible just because the capability exists somewhere.

**But the underlying goal doesn't need that API at all — a much
simpler answer already exists.** Finfloor's and Azura's visualizers are
public web tools. A contractor standing in a customer's room, with no
website of their own, can simply open `finfloor.co.za` or `azura.co.za`
directly in a phone's browser and use the real, working visualizer
immediately. No integration, no API, no building required. The "no
website" problem was never actually a blocker for the on-site case —
it would only have been one if the visualizer only lived embedded on
some other contractor's own site, which isn't how these tools actually
work.

**The real, evidence-based conclusion for Office, and the honest reason
behind it — not the one first written:** not "no gap because everyone
has a website," but "no gap because the supplier's own public tool
already serves exactly the on-site, standing-in-the-room case, on the
same phone Office already lives on, and no confirmed path exists to
fold that capability into Office even if it seemed worth attempting."
Building a visualizer from scratch would still be solving an
already-solved problem — exactly what Principle 12 warns against.
Office stays disciplined about what it actually is: a trusted record of
what happened, not a customer-facing image generator competing with
tools that already reach the people who'd use them, on the device
they'd already be using them from.

**A real correction to this whole conclusion, made in the same
session — the actual concern was sharper than "no website exists,"
and it changes the answer.** The real point: showing a customer a
supplier's own branded visualizer in the room, mid-sale, hands them
the exact name of the supplier — a genuine disintermediation risk, not
a small one. A customer who now knows precisely which brand and which
product can shop that around to another installer, or go directly to
the supplier. "Just open the supplier's site" doesn't solve this; it
actively creates it.

**Real, new evidence found the same session that reopens this
properly, rather than leaving the earlier conclusion standing
uncorrected:** Cloudflare Workers AI — the exact infrastructure this
project already runs on for transcription and vision-description — has
real, documented image-editing models, callable the identical way
every other AI call in this codebase already works (`env.AI.run(...)`).
Stable Diffusion Inpainting takes a photo, a mask marking a specific
region, and a prompt, and edits just that region. FLUX.2 unifies
generation and editing with multi-reference support — plausibly
capable of taking a room photo and a separate photo of the actual
flooring product, and compositing them together. This would happen
entirely within Office's own infrastructure — no supplier website, no
branding, no name ever shown to the customer. Not rebuilding Roomvo's
platform; a much narrower, specific thing — one photo in, one photo
out.

**Real, honest uncertainty, not overclaimed:** the model existing and
being callable is a different claim from it producing genuinely
convincing results for this specific case. Realistic floor replacement
— correct perspective, correct lighting, correct shadow — is a
genuinely hard computer-vision problem, and this hasn't been
prototyped or tested. A real, promising, technically-grounded avenue,
not a proven solution.

**Where this leaves the question:** not closed. The earlier "no gap to
fill" conclusion was reasoning from the wrong justification and is
superseded by this — a real, unbranded, in-app visualization may be
genuinely achievable using infrastructure already proven elsewhere in
this project, protecting exactly the supplier relationship a contractor
depends on. Worth a real prototype — a masked room photo, a product
texture, one actual generation call — before deciding anything further,
the same evidence-before-commitment discipline as everything else here.

## The Flutter rebuild — marrying the proven backend logic with the real, intended manifesto design (2026-07-26)

**A real, significant mix-up found and fixed first, before any of
this could safely start.** The web-preview deploy workflow had been
silently repointed, in an earlier part of this same session, from a
genuine `flutter build web` of `main.dart` to a static HTML manifesto
prototype — meaning every "web preview" screenshot for a stretch of
this session was showing a different artifact than believed. Found
by checking the actual workflow file's real history rather than
trusting either account, fixed by restoring the genuine Flutter
build and giving the manifesto its own, permanently separate
workflow and Cloudflare Pages project so this collision can't
recur.

**Reading the real, documented ember history before touching any
code.** Rather than treat the manifesto's four embers (tasks,
scheduler, finance, expenses) as a fixed given, `DECISIONS.md` was
searched directly and found to hold a real, dated design journey —
an earlier 2026-07-10 "notification embers" concept (actions-needed,
reports-ready, calendar, to-do) that was genuinely superseded three
days later once real, in-browser building happened, settling on
magnitude-based counts per business domain instead. The core,
durable principle survived every iteration: embers report a real,
deterministic count, never editorialize, never assert urgency —
"Peter must guide."

**Broadened to five embers, decided deliberately rather than
defaulted into**: Tasks folds in Snags (both a real, open thing to
do). Scheduler folds in Projects (a project is just grouped job
scopes). Finance stays customer-side. Suppliers broadens the old
Expenses ember to cover everything money-going-out — informal
expenses, POs, GRN, supplier invoices/payments, Aged Creditors,
Consumables Stock. Pending is genuinely new — the real, direct
fulfillment of the original 2026-07-10 "actions needed" concept,
proposed once, never wired into a UI until now.

**A real, comprehensive UI capability map built and pushed**
(`UI_MAP.md`) — every backend capability from `FEATURES.md` (itself
brought current first, since it had gone stale relative to
everything built earlier tonight) paired with its real or intended
home in the app, honestly naming genuinely open placement questions
rather than deciding them alone.

**Design inspiration drawn deliberately from this very chat
interface** — the hamburger drawer for navigating existing data
(Reports & Documents, People, and History folded in together, since
the manifesto's own separate swipe-right history gesture had two
real, named problems: a handle that blended invisibly into the
background, and chat bubbles the whole rebuild was already moving
away from) — and the three-dot menu for meta, account-level actions
(Account, Settings, Help) that were never real ember or business-data
concerns.

**History resolved as a real, deliberately simple ledger, not a
richer feature** — reasoned through directly: conversational lookup
already answers the specific "what did X pay" questions history
might otherwise serve, so a plain, chronological input/output log,
minimally built, is the right shape — expected to matter less over
time as trust in conversational answers grows, the same way
comfort tools naturally recede once their reason for existing fades.
Deliberately not over-invested in for exactly that reason.

**Two real steps of the agreed, sequenced rebuild built and proven
live, end to end, via real screenshots — not just claimed from a
green build status.** Visual shell: dark theme (the real, confirmed
manifesto palette), the five embers in the masthead, the hamburger
drawer and three-dot menu, an empty-by-default stage (no hardcoded
seed message — Principle 25, "empty screen is relief"), and real
camera/document upload wired to `/files/photo` and `/files/document`
— the single most significant functional gap named in `UI_MAP.md`,
closed. Real data wiring: two extended and two genuinely new backend
`/embers/*` routes, fetched on startup and after every real action,
verified against real, live counts (7 tasks, 4 projects, 1 supplier
owed, 11 real pending actions accumulated across the whole session).

**A real gap found only by Pierre actually testing it, not by
review** — tapping an ember did nothing, since the visual dot had
never been wired for interaction at all (a later step in the
original sequence). Built immediately rather than deferred further,
reusing the ember data already cached to compute the counts rather
than a separate fetch — verified live: tapping Pending correctly
opened a real sheet listing the actual, accumulated pending actions
from the whole session (#75 supplier_invoice, six real quotations,
a payment, two facts).

**All of this preserves, unmodified, every proven mechanism from the
original Flutter build** — confirm/reject via the real
`pendingActionId`/`factPendingActionId` fields, conversation-history
sending for pronoun resolution, and the record-and-upload voice flow
(deliberately kept over the manifesto's live browser speech
recognition, which doesn't carry over to a native build). Porting
these was never in question — only the visual and interaction layer
around them changed.

## The first successful native Android build — a real, multi-round debugging journey (2026-07-27)

**The real, decisive milestone**: the very first successful native
build of the entire redesigned app — dark theme, five embers, drawer,
camera/document upload, the full login flow, all of it — a real,
downloadable `app-release.apk`. Every prior native attempt, going back
to a single build months ago, predates this whole redesign.

**The real, wrong hypothesis, worth recording honestly rather than
glossed over.** The first failure — `jni-1.0.1/android/build.gradle`,
`Could not find method kotlin()` — was reasonably assumed to be a
Kotlin Gradle plugin version mismatch, and reasonably assumed to
trace back through `flutter_web_auth_2` → `desktop_webview_window` →
`jni`, given that chain's real, heavy desktop-platform footprint.
Both assumptions were wrong. Upgrading `flutter_web_auth_2` did
nothing. Bumping the Kotlin version did nothing.

**The real fix came from refusing to guess a third time and instead
running `flutter pub deps` directly** — a genuinely different,
correct root cause: `jni` comes from `path_provider_android`, a
dependency present since the very first build, months before any of
tonight's auth work. `desktop_webview_window` (confirmed via the same
tree) depends on nothing more than `flutter` and `path` — the
suspected chain never existed. `path_provider_android`'s own real
changelog confirmed the precise version boundary: 2.2.22 was the last
version before it switched to Kotlin DSL build files (2.2.23) and
then added the real, incompatible `jni` dependency (2.3.0). Pinned
via `dependency_overrides` to 2.2.22 — the real fix.

**Two more real, genuinely different bugs surfaced immediately after,
each traced and fixed in turn rather than assumed away:**
- `:file_picker:checkReleaseAarMetadata` failed because a transitive
  dependency now requires `compileSdk` 36+, while the app itself only
  overrides its own `:app` module's `compileSdk` — each third-party
  plugin module is its own, independent Gradle subproject with its
  own setting. Fixed with a real `subprojects { afterEvaluate { ... } }`
  block in the root `android/build.gradle.kts`, forcing every Android
  module to compile against 36.
- That fix itself then failed — "Cannot run Project.afterEvaluate(Action)
  when the project is already evaluated" — because the existing,
  pre-existing `evaluationDependsOn(":app")` block forces early
  evaluation, and the new block had been appended *after* it in the
  file. Fixed by registering it first instead, before anything else
  in the file could force evaluation — a real Gradle lifecycle-
  ordering lesson, not a logic error.

**The real, durable lesson, worth stating plainly for next time:**
when a Gradle/native-build failure names a specific package and line
number, get the real, proven dependency chain (`flutter pub deps`,
filtered for the actual package name) before forming any hypothesis
about which of your own dependencies caused it. A plausible-sounding
chain, reasoned from a dependency list alone, was wrong twice in this
exact session. Every patch here was also verified locally against a
realistic, simulated project structure before being pushed to a real
build — including one real bug (a misplaced Kotlin import) caught
this way before it ever reached Codemagic.

## The visual/UX design convergence, and the Office Runtime v1 build (2026-07-28–29)

A long, genuinely important arc that produced four real governance
documents and a working code foundation, none of which had been
written up here until now.

**The design convergence.** Pierre ran the same open question — what
should The Office actually feel like, and how should it be built —
through several parallel conversations (this one, Kimi, ChatGPT) and
brought each response back for real, critical evaluation rather than
picking one blindly. That process produced, in order:
`EXPERIENCE_BRIEF.md` (the braai/embers emotional core), the Ether
manifesto (`ether-manifesto.html`, voice-first, "the sigh state"),
`DESIGN_CONSTITUTION_V2.md` (real, numbered rules — the void is
sacred, embers are subconscious, motion is weather not theatre), and
`NATIVE_TRANSITION_BRIEF.md` (stop judging feel from the web preview,
verify on the real device). Each document sharpened or genuinely
corrected something in the one before it — Rule 3 of the Constitution
resolved a question the Experience Brief only gestured at; the
Constitution's "no waveform" instruction explicitly overrode the
Ether manifesto's waveform idea on that one point.

**The embers/orb redesign — real, iterative, several rounds of direct
feedback, not one pass.** Started from a simple `RadialGradient`
circle. Direct feedback ("these are all floating orbs, not embers")
led to a genuine mechanism change, not just a shape tweak: real,
seeded pseudo-random "crackle" (hold, then jump abruptly to an
unrelated value — see `_crackleValue` in `main.dart`) replacing a
smooth sine-wave pulse, since the smooth *behavior* was the actual
cause of the "orb" read, regardless of outline. Real bugs found and
fixed along the way, each confirmed live rather than assumed: a
`BlendMode.plus` additive blend needed `saveLayer` isolation or it
interacted with the canvas beneath it; `Stack`'s default
`Clip.hardEdge` was silently clipping `OverflowBox`'s larger glow
area at three separate nesting levels; the glow radius at high
brightness tiers exceeded its own `CustomPaint` canvas size. The orb
gained real layered depth (tuned gradient stops for a rim-light
effect, a genuine floor reflection) and a persistent, time-of-day
greeting using the real signed-in user's email rather than a
hardcoded name.

**The A/B experiment branch (`experiment/kimi-ab-test`) — explored,
not adopted.** Kimi proposed a fragment-shader "Heat Orb" (turbulent
noise field, no hard edge at all) as an alternative to the
`CustomPainter` approach. Built faithfully on a real, separate branch
with its own, separate Cloudflare Pages project
(`the-office-ab-experiment`) — deliberately isolated so it could never
touch the real preview. Two real bugs fixed along the way (a
non-nullable field compared against null; the shader-uniform API in
the original code didn't match Flutter's actual `dart:ui` API,
corrected to `fragmentShader()` + `setFloat()`) and one real
deployment issue (the project's Cloudflare-side production branch
didn't match what the workflow was pushing, routing every deploy to a
non-root preview URL rather than the visible one — fixed by pinning
`--branch=main` explicitly). The shader did render, and did
demonstrate genuinely different visual qualities (no discernible
edge) — but the branch was never merged into `main`; the
`CustomPainter` approach, refined through the crackle/depth work
above, is what's live. Worth remembering this branch exists if the
shader approach is ever revisited, rather than rediscovering it from
scratch.

**Office Runtime v1 — planned in `OFFICE_RUNTIME_V1.md`, then
genuinely built the same session.** Real, converged architecture
across the same multi-conversation process: a runtime answers "what
is the current state of the world," not "how do I animate this."
Deliberately excludes a generic capability/plugin framework — just a
single "Current Capability" slot, until enough real capabilities
exist to generalize their shape honestly from evidence rather than
guess at it.

Built, in order, each step verified with a real, successful build
before the next began:
- `lib/runtime/office_clock.dart` — a single, shared `Ticker`-based
  timing source. One real bug found and fixed on the first build that
  actually compiled it: `ChangeNotifier` lives in
  `package:flutter/foundation.dart`, not `scheduler.dart`, which only
  provides `Ticker`/`TickerProvider`.
- `lib/runtime/office_state.dart` — real, named states (Idle,
  Listening, Thinking, Responding, RoomOpening, RoomClosing,
  Executing) as the single source of truth, plus a minimal,
  `Stream`-based event mechanism for the few things a bare state
  value can't carry (a response's actual text, which ember is
  currently "thinking").
- All three existing visual systems — the orb's breathe cycle, all 5
  embers' drift, the decorative spark field — migrated off their own,
  independent `AnimationController`s onto the one shared clock. A
  real reduction: several independent tickers down to one shared
  timing source, each system's existing visual behavior deliberately
  preserved exactly (same math, same timing) so this was verifiably a
  migration, not a redesign — changing what it looked like at the
  same time as how it was driven would have made it impossible to
  attribute any difference to the right cause.
- Real state transitions wired at the actual, existing trigger
  points: Listening when recording starts, Thinking during a real
  response wait, Responding (and a real `ResponseReceived` event)
  centralized in `_updateMessage`/`_addMessage` — the one, shared
  place every flow's actual response already passes through, rather
  than duplicated across three flows' success/error paths.
  Executing wraps the real, guarded confirm/reject action.
- `lib/runtime/office_room.dart` — the real materialization pattern
  for Rule 8 ("a room opens, not a popup, not a sheet, not a toast"),
  using `showGeneralDialog`'s own `transitionBuilder` for a genuine
  fade+scale entrance rather than a standard bottom-sheet slide.
  People rebuilt as the first real capability against this — the
  first real test of whether the foundation actually supports
  building something new on top of it, not just organizing what
  already existed.

**Verified on the real, native device**, not just the web preview —
the explicit point of `NATIVE_TRANSITION_BRIEF.md`. Pierre's own
report: "looks a little bit smoother... the animations look the
same." Both halves of that are exactly the intended, predicted
result — smoother from fewer tickers and proper `RepaintBoundary`
isolation; visually identical because the migration deliberately
changed *how* the animations are driven, not *what* they look like.

## The Word Field System, the void realized in full, and real-time on-device speech (2026-08-06)

A single session that moved from an external design proposal to a
verified, working real-time voice pipeline on the actual device — four
real bugs found and fixed along the way, each traced from real
evidence rather than assumed, and one genuine architecture reversal
mid-build when a platform constraint turned out to make the original
plan technically impossible.

**The proposal, evaluated critically rather than adopted by
default.** An external conversation (reading like Kimi or ChatGPT)
proposed a full physics-based word-particle system — words drifting
toward the orb under simulated gravity, dissolving into an event
horizon, the response condensing back out "like water on glass." The
right response wasn't wholesale adoption or dismissal: it turned out
to already match, almost verbatim, the Speech Visualisation spec in
`NATIVE_TRANSITION_BRIEF.md` and a named-but-never-built "Speech
System" slot in `OFFICE_RUNTIME_V1.md`'s own architecture diagram —
not a new idea, an unbuilt one. What needed real pushback: the
cinematic "black hole"/"event horizon" framing fights Rule 7 (never
loud) and the Ember Test directly; semantic word-weighting needed to
ride the real, already-computed extraction result per Principle 1,
not a fresh AI judgement made just for the animation. Built as Phase 1
only — appear, drift, dissolve on a fixed timer — smallest real domino
first, the same discipline as the Runtime v1 build itself.

**Real bug 1 — invisible by simple ordering mistake.** `WordField` was
placed before `Column` in the body `Stack`, so it painted underneath
the permanent message ledger rather than on top of it. Found from a
real on-device screenshot Pierre sent showing the ledger with zero
trace of any animation. Fixed by reordering — a plain mistake, not a
deep one.

**Real bug 2 — invisible for a subtler, truthier reason, found only
by extracting real video frames.** Even after the ordering fix, still
reportedly invisible. Claude has no native video playback — the real,
working method turned out to be ffmpeg-extracting dense frame bursts
from Pierre's screen recordings and inspecting them as stills, dense
enough to reconstruct real timing. A `WF:N` counter (temporary,
explicitly marked as such, removed once it had answered its question)
proved the event pipeline genuinely worked — `WordSpoken`, defined in
`office_state.dart` since it was first written but never once emitted
anywhere until this session, was now firing and populating real
`WordParticle`s. A full-resolution frame then showed why nothing
registered anyway: the words were painting, correctly positioned, but
at 15px, low contrast, mostly caught mid-fade rather than at peak
opacity, directly overlapping the permanent ledger's own bold text
showing the identical words underneath. Not broken — camouflaged by
its own duplicate. Durable lesson, worth stating plainly for next
time: a video upload is genuinely usable evidence even without native
playback — ffmpeg frame extraction, done densely enough around the
moment that matters, found two real bugs tonight that reading the
code alone could not have caught.

**"The void stays a void" — Rule 3 realized in full, not the partial,
additive version this had been.** Pierre's own words: "the void stays
a void. It must never become a ledger or chat bubble... Words dissolve
out of my mouth into the void. Words appear out of the void as an
answer." This meant more than fixing contrast — the permanent
`ListView` ledger was removed entirely. Replaced with `_ActiveResponse`:
at most one office message ever visible at a time, a real crystallize-in
(fade + scale, not a chat bubble), held for a reading-time-proportional
duration, then dissolved — the direct mirror of Peter's own words on
the input side. `_messages` itself was deliberately left untouched
underneath — it still feeds `_recentHistory()` for real pronoun
resolution ("her" → "Jenny"), and the real transcript already lives
server-side regardless of what the screen shows; the void performs
forgetting, the backend doesn't. One non-negotiable safety rule
enforced here: a message carrying an unresolved `guard()`-held pending
item (a real payment, invoice, quotation) never auto-dissolves while
any item on it is still pending — enforced by simply never arming the
dissolve timer while that's true, reusing `_MessageLine` and
`_resolvePendingItem` completely untouched rather than rewriting any
part of the confirm/reject path itself.

**Real bug 3 — the void's two halves racing each other.** Once both
halves existed, a real screen recording showed the answer crystallizing
in while Peter's own words were still visibly dissolving on top of it
— the backend had answered faster than the input words' natural ~4s
cycle. Not a delay problem; fixed by having the response's arrival
immediately clear any still-visible input words and activate after one
short, deliberate 220ms beat, rather than either colliding with them
or making every answer wait out the words' full natural life for no
reason.

**Real bug 4 — a ~24-second dead first attempt, found the same way.**
A third recording showed 24 straight seconds of a completely
unchanging idle screen before anything happened at all — not "no
visual feedback," genuinely no message ever added, meaning the
recording flow never completed on the first real attempt. Best
evidence-based explanation, not fully confirmed: Android's own
permission dialog likely intercepted the interaction. Separately, real
code review confirmed the orb does attempt a recording-state visual
change (a brighter gradient blend) but the base color stays identical
in the common, non-"all clear" case — the same low-contrast pattern as
bug 2, flagged but deliberately not fixed in this pass, since the
architecture change below made it moot for voice specifically.

**The architecture reversal: real-time on-device speech recognition
replaces record-then-upload entirely.** Pierre's real, pointed
question — why does voice input here lag ~8 seconds when live
transcription elsewhere feels instant — led to a proposal to run
on-device recognition alongside the existing audio-upload pipeline,
framed as "nothing else about the pipeline changes." That framing was
wrong: Android does not support recording raw audio while on-device
speech recognition is active at the same time, confirmed directly
against the speech_to_text plugin's own documentation, not assumed.
Surfaced honestly before writing any code, with the real fork it
created: on-device recognition as a mere preview (keep the existing
architecture, accept the lag) versus on-device recognition becoming
authoritative (instant, but no second, server-side transcription pass
to catch a mishearing). Pierre chose the latter explicitly, naming the
real accuracy tradeoff and the existing guard()/confirm mechanism as
the accepted mitigation.

Built: the entire record→upload→server-transcribe pipeline for voice
removed (`record` and `path_provider` dependencies dropped entirely,
confirmed genuinely unused elsewhere first). `speech_to_text` (7.4.0)
now drives live recognition directly; each new recognized word is
diffed against the previous partial result and emitted as its own
`WordSpoken` event the instant it arrives — real appear-and-dissolve
per word, live, not a batch replay after the fact. The finalized
transcript posts through the exact same `/messages/text` endpoint
typed messages already used, rather than a separate voice-specific
route. `patch_android_manifest.py` gained the real `<queries>` block
Android 11+ requires before the OS's own speech service becomes
visible to the app at all — a documented plugin requirement, not
guessed at. Real robustness built in deliberately, not assumed: an
explicit tap-to-stop sends whatever was heard directly rather than
depending solely on the plugin's own `stop()` reliably firing one more
result callback; a status listener resets the recording state if
Android's own short pause timeout ends a session with no explicit
second tap; an error listener prevents the mic from ever looking
permanently stuck on.

**Verified on the real device — a real, unambiguous success.**
Pierre's own words: "instant, words floating, disappearing, black
screen, rendered a response. Native speech, perfect." First Codemagic
build carrying a genuinely new native dependency, first try. The web
preview build passing throughout this whole arc was real signal for
compilation correctness — never mistaken for confirmation of on-device
plugin behavior, timing, or contrast, which is what real device
testing kept catching that reading code alone did not.

## The real orb rebuild — the case against tuning, and Stage 0 confirmed (2026-08-07)

A separate real critique, delivered plainly: "our embers are in the
wrong place they don't look or behave like embers, our orb looks like
a 2D ball, the background doesn't do much... the visual is flat and
boring." Verified against the actual code before agreeing with any of
it — the orb is a plain `Container` with a static 4-stop
`RadialGradient`, the embers are business-domain tap targets wearing
an ember costume, and the ambient field is small gradient-dot circles
drifting upward. The code comment on that last one already quoted a
*previous* round of this exact complaint ("not orb looking floating
balls") — the earlier fix added an opacity flicker; the shape never
changed. Same complaint twice, because the first fix treated a
materials problem as a timing problem.

**The real, structural conclusion:** Canvas primitives — circles,
gradients, blur — cannot produce "fluid" or "alive" no matter how long
they're tuned, because those qualities come from surface behavior, not
shape. That's what fragment shaders exist for. Two rounds of external
research (evaluated critically, not adopted by default, matching the
Word Field arc's discipline) proposed real, verified reference
material: `LiquidGlassOrbShader.metal` (real, sophisticated "single
coherent swell" wave design — but Metal, not GLSL, needs real
translation, not reuse), `orb.js` (real GLSL, but Flutter's
`FragmentProgram` only accepts a fragment shader — no vertex stage, no
`attribute`/`varying` — so its structure needs real interface work;
also honestly closer to a JARVIS energy orb than the calm-lake target),
and `liquid-shape-distortions` (real, MIT, 107 stars — but its own
README calls it "psychedelic" and built for "rave posters," the
opposite end of the spectrum from calm; the fBM/simplex noise
technique is the real value, not its tuning). Flame engine was
separately proposed and rejected — real and legitimate (10.7k stars,
actively maintained), but adopting a second rendering/game-loop
paradigm to re-earn tonight's already-verified architecture from zero
was the wrong trade for a benefit that was still theoretical.

**Staged plan, refined through one real round of external critique**
(the same evaluate-don't-adopt discipline applied here too — most of
it adopted, one part pushed back on): six stages, each gated on a real
device recording before the next begins. Stage 1 explicitly knows
nothing about Office state — time, resolution, and fixed material
parameters only, so a wrong-looking result can only mean the material
is wrong, not the state machine or controller. The `OrbController`
translates semantic state into material parameters (`energy`,
`swell`), never `if state → playAnimation()` — the concrete API shape
of "simulate, don't animate." Interaction (`interactionStrength`,
`X`, `Y`, `age`) stays separate from state (`stateEnergy`,
`stateSwell`) so a tap disturbs the material without changing what
state it's in — "same lake, different disturbance." The old Container
orb stays reachable behind a runtime toggle rather than a branch,
specifically so old and new can be compared in the same build without
a second Codemagic cycle. One real pushback on the external proposal:
literal `.mp4` recordings committed into the repo were rejected —
binaries don't belong in git and can't be diffed — real findings go in
this file instead, the same discipline as everything else here.

**Stage 0, confirmed on the real device.** Deliberately the most
brutal version possible: a single trivial `.frag` shader — no SDF, no
noise, no helper functions beyond necessary — proving asset
declaration, `impellerc` compilation, `FragmentProgram.fromAsset`
loading, real-device rendering, and per-frame uniform updates, all in
one pass, driven by the existing `OfficeClock` rather than a new timer.
Verified Flutter's exact current shader conventions directly against
the live documentation before writing anything — `#include
<flutter/runtime_effect.glsl>`, `out vec4 fragColor` (never
`gl_FragColor`), `FlutterFragCoord()` (never `gl_FragCoord`, which
Impeller doesn't support) — rather than relying on possibly-stale
training knowledge for a case where a wrong guess would have wasted
the entire point of the stage. Mounted as a small, off-by-default,
purely additive overlay toggled from the existing more-menu, never
touching the real orb's own rendering — the feature-flag discipline
applied from the very first stage, not deferred to Stage 2. Pierre's
own real-device confirmation: "Success." The pipeline is proven; Stage
1 is now a contained graphics problem, not an open question about
whether Flutter and this project's Android setup can run shaders at
all.

## The real data-loss bug — on-device speech revisions silently discarding a correct transcript, and the confirmed fix

**The real, honest starting point:** three separate, clean, unambiguous commands tonight — a new customer, an invoice, a scheduled install — all arrived at the server missing their beginning, including the customer's name every time. This was first mistaken for a possible extraction or ambiguous-hold regression from earlier tonight's work; checked directly and ruled out, since none of that code runs until a customer name already exists, and none of it exists on `/messages/text`'s path at all. Also checked and ruled out: a Cloudflare outage (the Worker was confirmed live and responding), and the earlier "forget that last one" self-correction theory, which didn't hold once the same exact sentence, spoken slowly and deliberately a second time, produced the identical truncation — `"on Friday"`, verbatim, twice. A repeatable, deterministic result rules out random mishearing.

**The real mechanism, traced directly in `main.dart`, not guessed:** the on-device recognizer can revise an earlier guess mid-utterance rather than extend it — already partially documented in this file's own existing comment on that exact branch. When it does, the app clears the display and treats the revision as the whole transcript, discarding everything accumulated before it. Whatever got sent — through the natural final-result path or the manual tap-to-stop path — was whatever the recognizer had most recently revised itself to, with nothing keeping track of the longest, most complete thing it had actually produced.

**The real fix:** a new `_longestTranscript` field, updated on every recognizer callback and never allowed to shrink, reset at the start of each new listen session alongside `_lastPartialTranscript`. Both real send sites now send whichever is genuinely longer between the current result and the longest one seen this utterance — so a late, shorter revision can no longer overwrite an already-correct, complete transcript. A final result that's genuinely longer (the normal happy path) is unaffected.

**Confirmed working end to end, not just at the capture:** the exact sentence that failed twice tonight — "schedule stylish to install for Steven on Friday" — was repeated after the fix shipped and a real Codemagic rebuild, and this time landed whole: customer "Steven" created, job scope #49 created with installer "stylish," description "installation," and "Friday" correctly resolved to a real calendar date, all correctly linked back to the capture that produced them.

**Also real and worth keeping on record, separate from this bug:** the generic `"Got it."` fallback (a much older, pre-existing pattern, not part of tonight's regression) still doesn't distinguish "nothing to report because everything worked" from "nothing to report because nothing was extractable." That's a real, smaller, still-open honesty gap — not urgent, but real, and it's what made this bug so much harder to notice in the moment, since a silent data-loss and a genuine success currently sound identical.

---

## The logo, actually working — found via the discoverability-plus-audit pass, not guessed at

**The real starting point:** FEATURES.md claimed the logo was "ready to appear on generated PDFs." Tested directly rather than trusted — it wasn't. Every real PDF generator queried the business's name, VAT number, and address, but none of them ever selected `logo_r2_key` or called any image-drawing function at all. Stored and served back correctly; never once drawn onto anything.

**A second, deeper gap found in the same pass:** there was no real, discoverable way to upload a logo in the first place. `/business-profile/logo` existed as a working endpoint, but nothing in the app ever called it — the tiny placeholder found on file (plain text reading "Zululand Flooring" in a box, 1502 bytes) was almost certainly a raw test upload from an earlier session, not a real feature.

**Both fixed, then refined through several real, honest rounds against real generated documents:**
- A shared `drawLogoIfPresent` helper, called from all real render points across all four document types (invoice/quotation, statement, aged debtors, profit and loss) — including both pagination continuation pages for the two paginated documents, now living inside their `drawHeader` closures (made async for this) so the logo repeats correctly on every page the same way the rest of the header already does.
- **Position bug, caught on a real document:** the first version's Y math placed the logo's bottom edge below the header content's own start line — it was overlapping "BILL TO" and the customer's real address. Fixed, and moved from top-right (where every one of these documents already puts the *recipient's* details) to top-left, beside the business's own name — a business's own logo can never again collide with a customer's information, by construction.
- **Redundancy, caught by direct feedback:** the logo already carries the business's own name as part of its own design, so drawing the separate "Zululand Flooring and Blinds" text alongside it was genuinely redundant, not just visually busy. The name text is now skipped entirely whenever a logo is present, and falls back exactly as before whenever no logo is on file — never losing a business's name off a document that has none.
- **Sizing, refined through three real rounds against real generated invoices**, including one with the exact intended size circled directly on a screenshot: grew from an initial 120×26 all the way to 300×85, re-anchored near the true top of the page rather than a point sized for the text line it replaced, confirmed safe against the independently-positioned "BILL TO" block before each enlargement.
- **New discoverability, built the same real way as every other room:** "Business Profile" added as a fourth item in the existing drawer, opening a real "Upload Logo" action using the gallery picker (a real logo is almost always already a saved file, not something to photograph live).

**Confirmed working, real device tests, multiple rounds:** the logo now renders correctly — properly sized, properly positioned, no overlap, no redundant text — on a real generated invoice, with the business's actual logo, uploaded through the actual new feature rather than a raw API call. Confirmed directly: "Its good for now."

---

## A real, live UX gap: the app silently discarded the server's own confirm guidance

**The real starting point:** right after the confirm/reject race-condition
fix deployed, a real, live request — "generate an invoice for Thanda
Royal Game Reserve for sisal carpet installation, R98000 excluding VAT"
— correctly triggered an `identity_collision` check ("Thanda Royal sounds
like an existing customer, confirm?"). After confirming, no invoice
appeared, and it reasonably looked like something had just broken.

**Traced directly rather than assumed related to the race fix just
pushed:** `identity_collision`'s confirm handler does exactly what it's
supposed to — creates the real customer record, then replays the
original request through `processOneExtraction`. Since invoice creation
is itself a consequential write requiring its own confirmation, this
replay correctly created a *second*, separate pending action — an
"invoice" one — rather than an immediate, final invoice. Confirmed live,
through the app's own real "Pending" ember (`/embers/pending`, the same
member-open route every real member can already reach): the invoice
action was there, waiting, and confirming it produced the real invoice
correctly.

**The real gap wasn't the backend — it was the client silently
discarding what the backend already said.** `processOneExtraction`'s own
return shape already includes a real, clear `message` field —
`"Invoice noted for Thanda Royal of R98000 — needs your confirmation
(action #X) before it's recorded."` — confirmed directly in the real
source. `main.dart`'s confirm handler only ever read `pdfUrl` from a
successful confirm response; `message` was never read or shown at all,
regardless of whether the tapped pending item was found locally or not.
Every confirm that triggers a replay and creates a new, follow-up
pending action — not just this one — left the person with zero
indication anything further was needed.

**Fixed on the client:** `message` is now read and shown whenever
present, in addition to the existing local status update, so real,
substantive server guidance (a new pending action, a job scope also
recorded, an installer conflict) actually reaches the person doing the
confirming. The generic "Confirmed."/"Rejected." fallback is skipped
when a real message is available, since the real message already
implies success on its own.

---

## The app shows the server's own explanation of a usage-limit refusal (SHIP_CHECKLIST.md item 6), 2026-10-14

**The problem, confirmed in the code.** In ENFORCE mode a member over the daily limit gets a 429 with a plain-language `error`, but the app showed **"Something went wrong (429)."** for a text message and **"Upload failed (429)."** for a voice or file upload, which would have looked like a bug. (Enforce is not switched on anywhere real, so nobody has seen this.)

**The fix.** One small helper in `app/lib/main.dart`, `_serverReason`, used at the three places the app sends something that uses the model (both text sends, which are identical blocks, and the upload helper that serves every file upload). It acts **only on a 429**, reads the server's explanation from the `error` key, uses it only when it is a non-empty string, and otherwise says "Too many requests right now. Please try again later." Every other failure keeps exactly the wording it had. A refusal comes BEFORE the idempotency record is created, so the app's own retry is not left stuck.

**What is and is not verified.** **The Dart cannot be compiled or analysed here (no Dart or Flutter in this environment; the build is Codemagic).** What I could do: parse the whole 8,030-line file with a Dart grammar **before and after: zero parse errors both times (8,046 lines after)**, parse the new helper alone (zero errors), and confirm the helper's name is unique. **That is evidence of correct syntax, not a type-check or a build.** A guard in the suite pins the CONTRACT between the two sides (the server's 429 body carries the explanation under `error`; the app reads that key, acts only on 429, and is used at all three sends, with no bare "(429)" wording left) and **two breakages were caught** (the helper acting on every failure status; an upload left showing a bare 429). **The change reaches Pierre only when he rebuilds the app in Codemagic and installs it**; if the build fails nothing is harmed (the installed app is unchanged) and the build log says why. **Not done:** showing the `X-Usage-Warning` header (warn mode is for the operator, not the member), and an in-app usage display.

**Still open: the old GitHub token** is still valid (re-tested again after this push; HTTP 200).


---

## Getting the Team screen compiled, 2026-10-18

**What happened.** Pierre opened the app and saw no Team drawer. That was expected and my fault for not saying so plainly: the screen was on a branch because I could not compile Dart here, and Codemagic builds from `main`. The question was how to remove that blocker without waiting for him to start a branch build.

**The find.** The repo already had a workflow (`deploy-web-preview.yml`) that builds the REAL app for web on GitHub, as a free loop separate from Codemagic, but only on pushes to `main`, which is exactly where I did not want unverified code. I had treated "no Dart SDK" as a fixed constraint; the right move was to look at what CI could already do. A copy that compiles every OTHER branch and deploys nothing turned "never compiled" into "compiled on real Flutter" within about ten minutes.

**The first run failed, and read correctly it was good news.** `flutter analyze` reported 121 issues and one error, in `test/widget_test.dart`: a sample file `flutter create` adds in CI that refers to a class the app does not have. So the error was an artefact of the scaffolding, not the app, and the Team room itself had none. I could only see that because I extended the existing log-excerpt tool to pick out the analyzer's lines (the logs cannot be downloaded from where I work); guessing would have meant "fixing" the app. The second run, analyzing only `lib/`, passed the analyzer and the full web compile.

**The decision to merge.** The branch existed because the code had never been compiled. That reason was gone. The remaining difference is Android versus web, and the room uses only Flutter widgets, `http` and `Clipboard`, so I judged that low risk and merged, with the web-preview deploy on `main` as a second independent compile (it succeeded). I said plainly that an Android build and a tap on Team are still the real confirmation.

**Not done, said plainly.** Not installed: Pierre must install the Codemagic build before the item appears. Not verified on Android or a phone. The web preview has not been opened, so whether sign-in works there is unknown. The compile check does not run tests (there are none for the app) and does not catch behavioural mistakes: it proves the code compiles, not that the screen does the right thing.

---

## Workspace context (backend wrap-up point 4), 2026-10-19

**The finding that shaped it.** Before designing, I read how the pipeline uses client-supplied conversation history: only to resolve WHO a follow-up refers to ("what does she owe?"). It has no notion of reports or periods, because reports are fetched through routes, not through speech. So there is currently NO consumer that could meaningfully use "the user is looking at September's profit and loss". The scope Pierre's doctrine implies ("compare that to August" understood without repeating the report) needs an intent layer that does not exist, and ENVELOPE.md had already committed to "Phase 5 accepts and validates it, never trusting it for permissions". So I built the smallest reliable foundation and said plainly that it is not yet used: a strict contract, accepted, validated and recorded, with a dry run so the front end can be built against the real validator now.

**Choices and why.** (1) **Untrusted hint, allowlisted, partial-accepting.** A bad field costs only itself and is named, never its value, so a rejected value cannot carry injected text anywhere; an unlisted field is dropped and named (`unknown:role`), because a context that could carry authority would be an authorisation bypass in waiting. (2) **Not handed to the model and not to `processTranscript`.** The history text is already a client-controlled path into a prompt; I did not widen it, and a test pins that the context never reaches the pipeline or the permission code. (3) **The shape of a room is checked, not its name,** because the app owns its rooms; the reports are allowlisted because the server really has exactly three. (4) **Re-validate at the recorder,** so nothing unvalidated can ever be stored even if a caller forgets to validate. (5) **A new column, not a new table,** and an upgrade path for a table created before it, because production already has history tables in the old shape.

**Mistakes and near-misses of mine.** (1) **The first real rehearsal failed 75 of 76, and the failure was an OLD check that had been passing by luck.** It "tampered" with a signed link by replacing the LAST character of the signature with `x`. A 32-byte signature is 43 base64url characters and the last character carries only 4 meaningful bits, so when the original last character happens to be `w`, `x`, `y` or `z`, the replacement decodes to the SAME bytes and the "tampered" link is genuinely valid: a one-in-sixteen false failure. I did not dismiss it as a fluke: I compared the raw answers with the previous passing run (the tampered link returned 200 instead of 400), worked out why, confirmed it is harmless (the signature is checked exactly; an equivalent encoding of the same bytes is the same signature), and fixed the check to tamper inside the signed payload, which always changes real bits. I then searched for the same pattern elsewhere: one unit test overwrote the last two characters (a roughly one-in-a-thousand flake) and I made that deterministic. (2) My mutation of "unknown fields are kept" was too weak to take effect because a later step copies only allowlisted keys into the output; the real protection is that step, so I redid the mutation to break it as well. (3) Two of my pins were too blunt (one matched the function DEFINITION's `ctx: ExecutionContext` parameter; one forbade the word `ALTER` when the upgrade legitimately adds a column), and I corrected the tests rather than the code. (4) The type checker caught that a capture id can be null. (5) A third survivor was a mutation I ran against the wrong suite.

**What I could not verify.** The real rehearsal builds a FRESH business each run, so the history table is created in its new shape; the upgrade of an old-shape table is proven locally only. The voice header is not exercised by the real rehearsal. Both are stated in the runbook.

**The five points, as a whole.** Reports as data, the analysis layer, the history and audit record and workspace context are done, plus the operations health check (built by an earlier attempt of this same instruction and verified rather than trusted). The only remaining item from the five is customer emails for a failed payment or a coming lapse, which needs an email provider key from Pierre. The front end now has contracts to build against: `ENVELOPE.md`, `CONTEXT.md`, the report routes, `/reports/analysis`, `/history` and `/context/check`.

**Not done, said plainly.** Interpreting speech with the context; a retention and erase policy for the history (POPIA); the in-app plans button and the app's 401 handling; the terms and privacy pages; the live PayFast secrets; and the separate Google token-verification hardening.

---

## Front end, slice 1: the app handles a lapsed business, 2026-10-19

**The request.** Pierre: "Lets jump into the front end work", after the five backend points. The doctrine he shared says to inspect the existing Flutter code, find which principles are already implemented, preserve working functionality and report conflicts before proposing a redesign. So I audited first rather than starting to redesign, and the audit changed the picture: the app is not "flat". It already has the doctrine's void, orb, rooms, drawer, transient responses and hold-to-confirm. The honest gaps are specific and measurable: no reduced-motion support at all, almost no accessibility semantics, no use of the new envelope or context, no handling of a lapsed business, and no tests.

**Why this slice first.** It is the one gap that hurts today (the backend now cuts a lapsed business off and the app would show broken screens), it is small, and it is testable without a device. I deliberately did NOT start with the orb, reduced motion or any visual change: those are performance-sensitive, I cannot run Flutter or see a device from here, and the doctrine itself says to measure before introducing or changing effects.

**Design choices and why.** (1) **Wrap every request in one place** (`runWithClient`) rather than editing the 44 call sites, so nothing existing changes and a future request is covered automatically. (2) **Only a 401 saying `access_ended` raises the signal.** A different 401 is an ordinary sign-in problem, a 403 is a role refusal, and a 200 is not touched; confusing them would show a billing screen to a person who merely needs to sign in again. (3) **Hand every response back exactly as it arrived,** including the 401, so no caller changes behaviour. (4) **Share one inner client and make `close()` a no-op:** package:http makes and closes a client for every top-level call, so closing the shared one would have broken every request after the first. A test pins it. (5) **Close what is open on top before swapping the screen,** because a dialog open at the moment of the 401 would stay above the new screen. (6) **"Sign in" resets the signal and the home is rebuilt afresh,** so it finds no session; the app does not try to explain billing itself, because the server's own sign-in page already says why and offers the right action.

**Mistakes and near-misses of mine.** (1) **I pushed a workflow that did not parse, and the cause was my process as much as the file:** a step name had a colon and a space in it (the same mistake as earlier today), and my validation printed the error but I had chained the commit and push with `;` so they ran anyway. I fixed the name and made validation a hard gate (`&&`), so a broken workflow can no longer be committed. (2) **The first CI result said "21 passed, 1 failed", and the one failure was not mine:** it was `test/widget_test.dart` failing to LOAD, the stock counter test that `flutter create` generates in CI's web-bootstrap step, which refers to a `MyApp` class this app does not have. It had been silently polluting the test folder; the workflow now removes it when it is the stock one. I only found this because I made the record carry the failing test's name and message, instead of guessing which of 22 tests failed. (3) The CI is the only runner I have, so I made it produce a readable record rather than trusting a coloured mark, the same lesson as the stale "queued" statuses on the backend.

**What I could not verify.** Nothing has run on a device. The wrapper's behaviour on Android, the look of the new screen, and an end-to-end lapsed business reaching it are all unproven. The tests prove the logic and the widget behaviour in Flutter's test harness.

**Not done, said plainly.** The plans button, sending context, reduced motion and accessible labels (the largest gap against the doctrine), reading the envelope, a history view, an analysis view, and tests for the rest of the app.

---

## Front end, slice 2: the owner's Subscription item, 2026-10-20

**Why this next.** Pierre said "Continue". Slice 1 made the app cope when a business lapses; this slice closes the commercial loop from inside the app: an owner can reach the plans page without being told to find an e-mail or a web address. The backend route (`POST /billing/plans-link`) already existed and is owner-only, so the slice is small, testable without a device and carries no visual risk beyond one drawer item. I again deliberately left the orb, motion and any redesign for slices that can be checked on a device.

**Choices and why.** (1) **Open the link only if it is exactly what the server makes.** The page opens in the phone's browser with no session, so the signature in the link is the whole credential; if a wrong or tampered answer ever arrived, opening it blindly would hand an owner to another site. So `trustedPlansUrl` demands https, our own host (not a look-alike or sub-domain), the exact path, a token, and no credentials, odd port or fragment, and eighteen refusals are tested. (2) **Hide the item from non-owners** instead of showing it and refusing: the other owner-only items (Permissions, Team) are shown to everyone and their rooms explain, but a "Subscription" item that only ever says "only the owner" is noise; the server still refuses non-owners, so hiding is presentation, not security. (3) **Pure logic in its own file** (no plugins) so it can be tested in Flutter's harness without a device; `main.dart` only wires it. (4) **Never throw; tell the person in plain words,** and reuse slice 1's client so a lapsed business that taps it is taken to the "subscription ended" screen rather than shown a vague failure.

**Mistakes and near-misses of mine.** My first edit placed the new method directly under the comment that describes `_signOut`, which would have made the next reader believe the comment described my method; I noticed on reading the diff and moved it after `_authHeaders` before pushing. CI was green first time (analyzer 0 errors, 58 tests, web build), which is the first slice where the workflow's readable record made a first-try pass visible rather than assumed.

**What I could not verify.** Nothing has run on a device: how the item looks and sits, that the phone's browser opens, and the whole path from a tap to PayFast.

**Not done, said plainly.** Sending workspace context; reduced motion and accessible labels (the largest gap against the doctrine); reading the reply envelope; a history view; an analysis view; and tests for the rest of the app.


**Front-end slice 3 (2026-10-20).** (1) Reduced motion holds things still, it does not remove them: state is still shown (the orb still tells listening from idle, the ember still shows its count). (2) I did NOT pause the shared clock, although it would have stilled everything at once: the dissolving words are driven by it and would never have gone away. Each moving thing is stilled where it is drawn instead. (3) A reply under reduced motion is simply shown and removed, with no fade, so it is never left half visible. (4) Touch feedback (the ember flash, tap pulse, hold-to-confirm) is left as is: it answers the person's own touch and the hold is how a change is confirmed. Not verified on a device.

**Front-end slice 4 (2026-10-20).** (1) The envelope fills a gap and never overrides: the old fields decide what the person sees; the envelope is consulted only when they give nothing. Reason: the Phase 1 envelope is derived from the same fields, so letting it win could only add risk. (2) Held actions of the two choice types (project_ambiguity, ambiguous_person) are never turned into confirm gestures from the envelope: the envelope does not say which action the candidates belong to, and guessing is not allowed. (3) The mode is read but not acted on yet; it is a suggestion, and the app already presents confirm and clarify from the fields. (4) A reply with a version other than 1 is ignored entirely, per the contract's "a breaking change needs a new version".

**Front-end slice 5, sending workspace context: PARKED, not built (2026-10-20).** Found while inspecting: (1) every message is sent from the home screen (`_sendText` and the voice note); (2) every room opens as a full-screen dialog over the home (`showOfficeRoom`), so nobody can speak or type while a room is open; (3) the Reports item only opens a PDF outside the app, and the finance and aged-debtors rooms read the legacy `/debug/financial-snapshot`, with no period. So today the app has no screen that is "on screen" while a message is sent. Sending the last room as context would put a false claim in the audit record (`viewing`), which CONTEXT.md says must show what the app said was displayed. It becomes honest and useful once a workspace view lives on the home screen next to the orb (the analysis view, slice d). Order is therefore: history view (c), analysis view (d), THEN context (b). The claim `claim/frontend-5-context` stays taken; use a new claim name for the real build.

**Front-end slice 6 (2026-10-20).** (1) A NEW "Activity" item, not a replacement of "History": the old item lists raw captures from a debug route and includes things recorded before turn history existed, so removing it would lose working behaviour. Retire it later if you want, once Activity has history of its own. (2) Heard and said are shown as separate labelled lines, never merged into a transcript, because the record's whole point is that they are different things. (3) No search, filter or export yet: a record to read, not a main experience.

**Front-end slice 7 (2026-10-20).** (1) Layout B chosen by Pierre, for room to ask about specific open data later. The doctrine cost is that the orb shrinks while the sheet is open; it stays on screen, usable and the same object, and returns to full size on close. (2) The ordinary talk area is NOT modified: while the sheet is open a separate compact orb is shown instead, so normal mode cannot regress. (3) A sheet on the home screen, not a modal room, because only the home screen can send a message; that is what lets context (slice b) and spoken follow-ups work later. (4) The analysis shows what the server says it cannot know, in plain words, because that is the contract's own honesty rule. (5) Owner only for now; widen when the app can learn the profit capability.

**Front-end slice 8 (2026-10-20).** (1) Strictly honest context: built only from what a screen actually loaded, cleared when it stops being true, never sticky. The audit record shows what the app CLAIMED was displayed, so a stale claim would corrupt it. (2) The period and comparison are the server's own, read from the analysis answer, not the preset the person tapped. (3) `report: profit_and_loss` for both topics: expenses and profit are both analyses of that report. (4) The app validates with the server's rules before sending (stricter on the 3,660-day edge: both ends counted), so a bad claim is dropped on the phone instead of by the server. (5) Shown in the Activity room so the loop can be checked by eye.

**The projection layer vision saved (2026-10-20).** Pierre pasted the full "Projection Layer Design" as "the vision". Saved as `PROJECTION_VISION.md` (image links removed, provenance noted) and mapped against what is built in `VISION.md`. Decision recorded: it is the AIM, not the contract; the built contract stays `ENVELOPE.md` until a new version is deliberately cut. Reading of its scope: it concerns results of the intelligence (text, voice, photo, document), not every request the app makes, so room list fetches stay outside it. Suggested order, smallest first: (1) this save and map, (2) a shared backend/app contract fixture, (3) wrap photo and document uploads in the envelope and history, (4) a structured `refuse` mode and `replyId`, (5) content blocks and a renderer registry, only when a workflow needs them.

**Doctrine replaced by the vision; contract fixture added (2026-10-20).** Pierre confirmed the original design doctrine was chat-only and is replaced by `PROJECTION_VISION.md`, so none is to be saved. The envelope is now guarded by one shared fixture proven on both sides, so the backend and the app cannot drift silently. Moving to the vision's richer envelope must be a DELIBERATE new version (a version 2 is ignored by today's app by design), not an accretion.

**Direction recorded; the first step built (2026-10-20).** Pierre confirmed the direction: a full-stack ERP and BI backend, a conversational input at rest, actionable queryable reporting, tangible documents, and adapters to other programs, LLMs, tools and apps (his words are in `VISION.md`). First step, client neutrality: the in-band `__OPEN_DASHBOARD__` command in `message` was being offered as `speak` by the envelope and stored as what The Office said in history, so the Activity room, and any future MCP or API client, would have shown or read it as an answer. Fixed without changing any reply (installed apps keep working): the envelope never offers a command as speech (`unknown`: `message_is_an_app_command`), history stores a plain description, and the app reads older rows the same way. Not done on purpose: the structured `open_room` mode, which changes the contract and is a deliberate version decision. Not verified on real objects: no recorded production turn goes through a dashboard route in the probe.

**BI slice 1 (2026-10-20), revenue by customer.** The dimension is the CUSTOMER: invoices carry a required customer id, while product and category are not reliably populated (`CONVERSATIONAL_BI_ARCHITECTURE.md` already warned about category). It is a new topic on the existing analysis route, not a new engine, so authorization, the comparison default and the facts-only rules are inherited. Agreed with Pierre: a customer's outstanding invoices will be shown as CALCULATED, because payments are recorded per customer and applied oldest-first (the aged debtors basis), never matched to an invoice. Not built: speech choosing this analysis (it waits for the recorded-phrase gate).

**BI slice 2 (2026-10-20), a customer's receivables.** A query parameter on the existing aged debtors route, not a new route: the authorization is then identical by construction and no route policy or route count changes. The aged debtors report was refactored to share ONE allocation function with the new view (instead of two copies that could drift); its numbers are unchanged (golden recordings and aged debtors tests unchanged). Labelled CALCULATED, as agreed with Pierre, because payments are not matched to invoices.

**BI slice 3 in the app (2026-10-20).** The drill-down lives INSIDE the analysis sheet (a breadcrumb, not a new room or a new screen), so the orb stays on screen and the focus the person has narrowed to is exactly what the context sends. Going back keeps the revenue analysis without refetching, so the path taken is preserved. Invoice-level numbers are labelled CALCULATED in the view itself, as agreed. Two separate controls per customer line (see the records, open the invoices) rather than one nested tap, so each is reachable by a screen reader.

**Spoken follow-ups (2026-10-20).** Rules first, a model later, if at all. The repo's own principle is that language decides WHAT is asked and code answers; a precision-first rule set can be tested exhaustively offline against recorded phrases, costs nothing per message, and fails safe (a miss falls through to the ordinary pipeline). It only ever activates when the app says an analysis is on screen, so with nothing open nothing changes. Never guess a customer; ask. Answers are composed from the analysis's own findings and always say the records show what changed, not why. A reply carries only words, because a structured "switch the sheet" instruction is a contract change (a deliberate envelope version), not something to smuggle in a message string again.

**The read-only MCP adapter: shape decided (2026-10-20).** Pierre approved the recommended shape: owner-only first, inside the existing Worker (`POST /mcp`, routed to the business object), a read-only per-membership key (hashed, revocable, rate-limited, audited as "via MCP"), no writes and so no confirming in version 1. Hand-written minimal stateless MCP (JSON-RPC over POST) rather than an SDK or Cloudflare package, because the protocol surface needed is small and the packages were unverified. The full design is in `MCP_ARCHITECTURE.md`. Nothing is built yet; the first slice is the credential core.

**The Assistants screen (2026-10-21).** Keys are made and revoked in the app by the owner, so no manual step or workflow is needed and a key is never in a log: it appears once on the owner's own screen. The screen says plainly what a key can and cannot do, and warns that anyone holding one can read the figures until it is revoked. A static bearer key was chosen over OAuth because it needs no new sign-in machinery and suits hosts that let you set a header; hosts that only offer OAuth for remote servers are not served, which is the known limit.

## Envelope version 2: open_room and structured refusals (2026-10-24, Pierre chose the full scope)

Refusals were words inside `message`; the envelope may not guess from text. Decision: the places that refuse now also say so in a closed vocabulary (`worker/src/refusals.ts`: reason plus topic, no free text), and the envelope turns that, and a recognised screen command, into `refuse` and `open_room`. Only a reply that uses either is stamped version 2; every other reply stays byte-identical version 1, because the installed app drops any version but 1 (so it ignores version 2 and still works from `message`). Mode `refuse` only when every part of the message was refused (`refusalScope` whole); a refusal in part is reported, not promoted. Done in slice A: the dictation refusal and six whole-answer lookup refusals; the rest (composed answers, follow-ups, uploads, sensitive detail) is listed in HANDOVER and ENVELOPE.md, so absence of `refusals` proves nothing yet. Proof: 41 golden replies changed, every change a refusal field or the envelope (checked by a script, 0 others), and each new guard mutated and caught.

