# The Office — Native Flutter Transition Brief

The fourth real design/governance document, alongside `EXPERIENCE_BRIEF.md`,
`ether-manifesto.html`, and `DESIGN_CONSTITUTION_V2.md`. Given directly
by Pierre. Where the others describe the feeling and the rules, this
one sets concrete technical direction for how it gets built and
verified.

---

## Objective

We are no longer trying to recreate the web application in Flutter.
We are building the native experience. This is a redesign centred on
atmosphere, responsiveness, and emotion rather than feature parity.

The web prototype has proven the architecture. The Flutter
application must prove the experience.

## Primary Goal

The Office should not feel like software. It should feel like a calm
place — the feeling of sitting beside the embers of a braai after
everyone has eaten. Quiet. Warm. Confident. Nothing demanding
attention. Only readiness.

Peter should open The Office and feel less stressed than he did five
seconds earlier. If the UI creates anxiety, it has failed.

## Technical Direction

Target native Android first. Use Flutter's modern rendering pipeline.
Enable Impeller. Optimise for 60–120fps. Design around smooth
animations instead of static widgets. Minimise rebuilds. Profile
performance before introducing additional rendering engines.

**Do not introduce Flame or custom game engines unless Flutter itself
demonstrably cannot achieve the required experience. Optimise only
when necessary.**

## UI Philosophy

Almost everything disappears. The screen is mostly black — not dark
grey, not textured. Black. The emptiness is intentional; negative
space is part of the interface.

## The Orb

The red orb is the application. Everything revolves around it. It is
not simply a microphone button — it should feel like it possesses
weight: gentle breathing, subtle pulsing, tiny movement, rich glow,
soft reflection. Never frantic, never mechanical. The orb should feel
alive.

## Voice Interaction

The microphone is the primary interaction. Voice is the default.
Typing, camera, and files are secondary — everything else exists to
support conversation.

## Speech Visualisation

Do not display permanent transcripts. Instead: words briefly appear
as they're recognised, gently drift upward, slowly dissolve, letters
fragmenting into glowing particles that fade into the darkness.
Nothing accumulates. The interface should communicate "I heard you,"
not "here's another wall of text."

## Embers

The embers are not decoration. They are living shortcuts — each
represents an ingestion capability (camera, file upload, voice notes,
edit transcript, email, PDF, contacts). Each glows softly, slowly
brightens and dims, drifts only slightly, feels warm, and responds
immediately to touch. No labels — recognition comes from colour and
iconography.

**Behaviour**: embers should not behave like buttons. They should
behave like glowing coals. Subtle, organic, never synchronised, no
obvious loops.

**Interaction**: when tapped, an ember should acknowledge touch
instantly — it may brighten, grow slightly, move toward the central
orb, disappear into it. Only then does its function activate. This
reinforces that everything flows through one central intelligence.

## Screen Layout

**Upper 70%** — almost entirely empty. This is where spoken words
temporarily exist before fading. The emptiness is deliberate.

**Lower 30%** — contains the central orb, functional embers, minimal
ingestion silhouettes, thumb-accessible controls. Everything should
be reachable with one hand.

## Motion Design

Avoid obvious animations. Prefer breathing, drifting, floating,
fading, inertia, easing, momentum. Nothing should snap. Nothing
should bounce. Nothing should feel "cute." This is a professional
workspace.

## Sound

Future consideration. Near-silent interaction, very subtle audio
cues, no notification sounds, no artificial assistant voices.

## Performance Targets

The user should never perceive lag. Voice button response:
immediate. Scrolling: minimal. Animation: continuous. Input latency
should feel closer to a premium mobile game than a business
application.

## Design Principle

Every animation must answer one question: does this reduce Peter's
cognitive load? If an animation exists purely because it looks
impressive, remove it. If it creates calm, keep it.

## Final Vision

We are not building another ERP. We are building a place. When Peter
opens The Office after a long day, it should feel like sitting beside
the last glowing embers of a braai. Quiet. Warm. Trusted. Ready.
Nothing shouting for attention. Just a capable partner waiting for
the next instruction.

---

## A real, honest note on what this changes right now (2026-07-28)

This brief gives explicit permission to stop judging feel from the
web preview and move to real, native verification — Impeller has
never actually been confirmed active in any of tonight's testing,
since every screenshot so far has come from Chrome (CanvasKit), which
Impeller doesn't apply to at all.

The concrete, immediate action this brief calls for: explicitly
enable Impeller on the native Android build (previously relying on an
unconfirmed default), then get a real, fresh native build onto a real
device before judging feel any further. Everything else in this
document restates and sharpens direction already established in the
three earlier documents — the real, new instruction is "verify on the
real thing now."
