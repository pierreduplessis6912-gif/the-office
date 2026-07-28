# The Office v2 — Design Constitution

The most architecturally authoritative of the three real design
documents given by Pierre — not a UI spec, not a mood description,
but rules. Every design decision either obeys these rules or it
doesn't. Committed here verbatim, alongside `EXPERIENCE_BRIEF.md` and
`ether-manifesto.html`.

---

## Rule Zero

The Office is not an application. It is a place.

Peter doesn't "launch an app." He enters The Office. When he leaves,
he should feel lighter than when he arrived. Everything below exists
to protect that feeling.

## Rule 1 — Attention is Sacred

Peter's attention is the most valuable resource in the system. Never
steal it. Never waste it. Never ask for it unless absolutely
necessary.

If something can be handled automatically, handle it. If something
can wait, wait. If something needs Peter, ask once. Quietly.

## Rule 2 — One Intention Per Screen

The home screen has one purpose. Speak. Nothing else competes with
that. Choices create work. The Office exists to remove work.

## Rule 3 — The Home Screen Has No Memory

The biggest conceptual shift. Most software accumulates — messages,
notifications, lists, history. The Office does not.

The home screen should forget. After understanding, silence returns.
The Office remembers. The interface doesn't. Those are different
things.

## Rule 4 — Information Appears Only When Invited

Peter never sees data because it exists. He sees it because he asked.
The screen begins empty. Conversation reveals context. Context
disappears again. Nothing lives permanently on the home screen.

## Rule 5 — The Office Breathes

Nothing should feel frozen. Nothing should feel busy. Even doing
nothing, The Office should feel alive. Tiny ember movement. Soft
ambient motion. Subtle breathing. Almost imperceptible. Like a quiet
room.

## Rule 6 — Motion Has Meaning

Every animation answers a question. What is happening? Who is doing
the work? What changed?

Words drifting inward — the Office is listening. Vortex — the Office
is understanding. Card emerging — the Office has finished. Animation
is communication, never decoration.

## Rule 7 — The Office Is Never Loud

No flashing. No bouncing. No aggressive easing curves. No oversized
success messages. No celebration. Confidence is quiet.

## Rule 8 — Drawers Are Rooms

Stop thinking in navigation. Think architecture.

Peter says "Show John." The Customer Room opens. Peter says "Show
invoices." The Invoice Room opens. Peter says "Go back." The room
closes. Peter is always standing in one calm Office. Rooms simply
open around him.

## Rule 9 — AI Is Invisible

Never expose thinking. Never expose chains. Never expose models.
Never expose implementation. Only expose outcomes.

## Rule 10 — Every Feature Must Pass The Ember Test

Imagine sitting beside the embers after a braai. Would this feature
belong there? Would this animation belong there? Would this sound
belong there? Would this notification interrupt that moment?

If yes, it doesn't belong.

---

## Home Screen Specification

**Background** — True black. Not dark grey. Not warm charcoal. Not
textured. Black. It should disappear into the phone bezel. The
interface almost ceases to exist.

**Primary Object** — One large red circle. Everything else is
secondary. It should feel heavy, stable, inviting — like pressing it
is inevitable. It is not a button. It is presence.

**Embers** — Not indicators. Not buttons. Not navigation. Living
atmosphere. Represent quiet work, warmth, that The Office is awake.
Their movement should be random enough to feel alive, never
distracting.

**Intake Functions** (camera, files, scanner, edit transcript) — Not
permanently visible. Only softly suggested. Almost silhouettes. The
Office should encourage speaking first; everything else is a
secondary path.

**Speaking** — No waveform. Words emerge naturally, one at a time,
like thoughts becoming visible. After a short delay, each word begins
drifting. Eventually every word is consumed. Nothing remains.

**Processing** — No spinner. No loading wheel. No progress bar. Only
atmosphere changing — embers gather slightly, the centre breathes.
The Office should feel occupied, never stalled.

**Result** — A room opens. Not a popup. Not a chat bubble. Not a
toast. The relevant world quietly appears — customer, quote, invoice,
stock. Everything else remains in darkness.

**Completion** — The room closes. The Office returns. The red circle
waits. The embers continue. Silence.

---

## The Sentence Every Decision Must Answer

Before merging any code, ask one question: does this make The Office
feel more like software, or more like somewhere Peter wants to be?

If the answer is software, delete it.

## The Sentence That Unlocks Everything

The home screen should never become a workspace. It should remain a
sanctuary.

All work happens in rooms that open temporarily. The Office itself
stays quiet, warm, and empty. That's the difference between an
application and a place.

---

## A real, honest note on how this relates to the earlier two documents (2026-07-28)

This is the most architecturally decisive of the three. It resolves
real, open questions the earlier documents left unsettled rather than
just adding to them:

- **Rule 3 definitively answers a question `EXPERIENCE_BRIEF.md` only
  gestured at** ("the transcript is raw material... after
  understanding, it disappears"). This document makes it explicit and
  absolute: the home screen accumulates nothing, ever. Not a slower
  fade — no permanent ledger at all.
- **The "no waveform" instruction here overrides the waveform
  described in `ether-manifesto.html`.** Words emerging one at a time
  and drifting away is the real, current instruction; the manifesto's
  waveform visualization is superseded on this specific point.
- **Rule 8 ("drawers are rooms") reframes, rather than replaces,
  something already real and working** — the ember detail sheet and
  drawer navigation already open and close temporarily; the real
  shift is conceptual and experiential (a room Peter stands inside,
  not a UI element he taps to reveal), which should shape how these
  are built and animated going forward, not necessarily their
  underlying mechanism.

Given directly to Claude with explicit creative latitude: "free rein
to interpret, to decide, and to use Flutter's capabilities in order
to achieve this philosophy." Practicality still governs sequencing —
build toward this real, coherent target incrementally, smallest real
domino first, the same discipline as everything else in this project
— but the target itself is now unambiguous.
