# The Office Runtime — v1 Milestone Brief

The real, converged architecture direction for the next session,
following extended discussion across `DESIGN_CONSTITUTION_V2.md` and
`NATIVE_TRANSITION_BRIEF.md`. Not a refactor — a foundation. Committed
here so it's the real starting point next time, not something to
reconstruct from memory.

---

## The core distinction

You are not building an animation engine. You are building a runtime.

An animation engine answers "how do I animate this?" A runtime
answers "what is the current state of the world?" Everything else —
every glow, drift, transition — becomes a consequence of that answer,
never a one-off animation call scattered through the code.

Nothing should ever call an `AnimationController` directly again once
this exists. State changes; the runtime figures out what that means
visually.

## Why this, and why now

Retrofitting animation onto code that wasn't built with state
transitions in mind is a real, known trap — every new feature ends up
fighting the existing structure instead of just describing a new
state and letting the visuals follow. The real vision already
includes a lot that isn't built yet — drawers that feel like stepping
into office rooms, words dissolving into the void, more embers, real
state transitions between idle/listening/thinking — and building the
foundation before those exist is genuinely cheaper than retrofitting
it under each one individually.

## What this deliberately excludes, and why

There is no generic plugin framework. No capability registry. No
extension API. There is simply **Current Capability** — a single,
replaceable slot. Today that might be Camera. Tomorrow, People.
Eventually Quotes, then CRM.

This is deliberate, not an oversight: designing a generic interface
for capabilities that don't exist yet means guessing at their common
shape from zero real examples. Build three or four real capabilities
against the single slot first — their common shape will reveal itself
honestly, from real evidence. That's when a real capability interface
gets extracted, not before.

## Architecture

```
Flutter
    │
    ▼
Office Runtime
    │
    ├── Engine Clock       (single source of timing, delta time)
    ├── State Machine      (the authoritative source of truth)
    ├── Event Bus          (systems react to events, never call each other directly)
    ├── Renderer           (draws layers only, no logic)
    │
    ├── Orb System
    ├── Atmosphere System   (the spark field)
    ├── Speech System       (listening/thinking, words appearing and dissolving)
    ├── Whisper System      (floating acknowledgement particles)
    ├── Ember System         (the 5 real, functional embers)
    │
    ▼
Current Capability
```

**The state machine is the real investment, not to be compromised
on.** Real, named states: Idle, Listening, Thinking, Responding,
Transitioning, RoomOpening, RoomClosing, Executing. Visual behaviour
comes from state transitions, never from arbitrary, direct animation
calls.

```
State changes → Event emitted → Systems update → Renderer interpolates → Frame drawn
```

## The "alive" feeling, precisely

Not from graphics quality. From continuous simulation — nothing waits
for a button press before it exists. The dust is already moving. The
orb is already breathing. The embers are already there. When Peter
speaks, he isn't triggering an animation — he's perturbing an
existing, ongoing simulation. That's the real, specific mechanism
behind "alive," not a vague aspiration.

## The v1 milestone, explicitly scoped

Not "new animations." Not "new UI." Not "the People room." The
explicit objective:

- One engine clock
- One event bus
- One authoritative state machine
- One render pipeline
- Existing systems (orb, speech, atmosphere, whispers, embers)
  migrated onto that foundation
- One real capability (e.g. Camera or People) implemented against it

Once this exists, every future room, interaction, and animation
becomes dramatically simpler to add — each one expresses a change in
runtime state rather than inventing its own animation logic from
scratch.

---

## Before this work begins

A real, honest gap named directly, not glossed over: there has been
no native-device verification since before tonight's crackle/ember
and orb-depth work. Every judgment since has been made against two
web preview URLs (CanvasKit), never Impeller, which is what the app
will actually run on. A fresh native build and a real look on-device
is the honest starting point for the next session — not a fourth
iteration to compare, just ground truth on what already exists before
building the foundation underneath it.
