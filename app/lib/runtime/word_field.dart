import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';

import 'office_clock.dart';
import 'office_state.dart';

/// The Office Runtime — Word Field System (Phase 1 of 4).
///
/// Real, working start on the Speech System OFFICE_RUNTIME_V1.md's
/// architecture diagram named but never built, and on the literal
/// Speech Visualisation spec in NATIVE_TRANSITION_BRIEF.md: "words
/// briefly appear as they're recognised, gently drift upward, slowly
/// dissolve... Nothing accumulates." Same thing HANDOVER.md flagged
/// as "explicitly deferred, on purpose, not forgotten."
///
/// Also the real, first consumer of the event bus — [WordSpoken] was
/// defined in office_state.dart from the start but never emitted or
/// subscribed to anywhere until this file.
///
/// Deliberately scoped to Phase 1 only, smallest real domino first,
/// same discipline as the Runtime v1 build itself:
///   Phase 1 (this file)  — appear, drift, dissolve on a fixed timer.
///   Phase 2 (not built)  — gravity/drag genuinely pulling words
///                          toward the orb during OfficeState.thinking,
///                          replacing the fixed timer with a real
///                          simulation.
///   Phase 3 (not built)  — dissolve behaviour driven by each word's
///                          real weight in the deterministic
///                          extraction result (which words the worker
///                          actually matched to a fact) — never a
///                          fresh AI judgement made just for the
///                          animation, per Constitution Principle 1.
///   Phase 4 (not built)  — the response itself condensing into view,
///                          the mirror image of this file.
///
/// A real, honest scope note, not glossed over: this does not remove
/// the permanent message ledger. Rule 3's bigger, separate question
/// — "no permanent ledger at all" — is deliberately not decided here.
/// The same transcript still appears in the chat ledger underneath
/// this animation until that larger decision is made on its own.
/// This file only adds the animation on top of what already exists,
/// without removing anything — reversible, additive, verifiable in
/// isolation.
///
/// Real, honest data-safety note: this is a UI-only treatment. Words
/// visually dissolving here has no bearing on Constitution Principle
/// 3 ("Nothing Is Lost") — the real transcript is already captured
/// and persisted server-side, via the same upload path that existed
/// before this file. The void performs forgetting; the backend
/// doesn't.
class WordParticle {
  final String text;
  final double spawnTime; // clock.elapsedSeconds when this word appeared
  final double x; // 0..1 horizontal seed position, deterministic per word
  final double driftSeed; // seeds this word's own small wobble, so no two words drift identically
  final double weight; // Phase 1: derived only from word length — real semantic weight is Phase 3
  const WordParticle({
    required this.text,
    required this.spawnTime,
    required this.x,
    required this.driftSeed,
    required this.weight,
  });
}

class WordFieldController extends ChangeNotifier {
  WordFieldController({required Stream<OfficeEvent> events}) {
    _subscription = events.listen(_onEvent);
  }

  late final StreamSubscription<OfficeEvent> _subscription;

  final List<WordParticle> _words = [];
  List<WordParticle> get words => List.unmodifiable(_words);

  // Real timing, matching the literal brief — a real appear, a real
  // hold long enough to actually read the word, then a real dissolve.
  // Nothing snaps, per Rule 7 ("no aggressive easing curves").
  static const double appearSeconds = 0.4;
  static const double holdSeconds = 1.6;
  static const double dissolveSeconds = 1.4;
  static const double totalLifetime = appearSeconds + holdSeconds + dissolveSeconds;

  // Real, deliberate stagger — "words emerge naturally, one at a
  // time, like thoughts becoming visible," never all at once.
  static const double staggerSeconds = 0.14;

  double _clockTime = 0;

  void _onEvent(OfficeEvent event) {
    if (event is WordSpoken) {
      showTranscript(event.text, _clockTime);
    }
  }

  /// Called every tick from the widget so this controller always
  /// knows "now" without owning its own clock — the engine clock
  /// stays the single source of timing, per OFFICE_RUNTIME_V1.md.
  void tick(double elapsedSeconds) => _clockTime = elapsedSeconds;

  void showTranscript(String text, double now) {
    // Real cleanup — drop anything already fully dissolved before
    // adding more, so back-to-back captures never accumulate an
    // unbounded list. Rule 3: the home screen has no memory.
    _words.removeWhere((w) => now - w.spawnTime > totalLifetime);

    final rawWords = text.trim().split(RegExp(r'\s+')).where((w) => w.isNotEmpty).toList();
    for (var i = 0; i < rawWords.length; i++) {
      final word = rawWords[i];
      // Deterministic seeded spread, not a stored Random — matches
      // the existing spark-field idiom (position as a pure function
      // of a seed, not mutated state) so this is safe to reason about
      // frame to frame without hidden state drift.
      final seed = word.hashCode ^ (i * 7919);
      final x = 0.15 + (seed.abs() % 1000) / 1000 * 0.7;
      _words.add(WordParticle(
        text: word,
        spawnTime: now + i * staggerSeconds,
        x: x,
        driftSeed: (seed.abs() % 628) / 100, // roughly 0..2π
        weight: word.length.toDouble(),
      ));
    }
    notifyListeners();
  }

  /// Real, deliberate reset — called when a fresh utterance begins,
  /// so a new capture always starts from a clean field rather than
  /// words from a previous one lingering into it.
  void clear() {
    _words.clear();
    notifyListeners();
  }

  @override
  void dispose() {
    _subscription.cancel();
    super.dispose();
  }
}

class WordField extends StatelessWidget {
  final WordFieldController controller;
  final OfficeClock clock;
  const WordField({super.key, required this.controller, required this.clock});

  @override
  Widget build(BuildContext context) {
    return IgnorePointer(
      child: RepaintBoundary(
        child: AnimatedBuilder(
          animation: Listenable.merge([clock, controller]),
          builder: (context, child) {
            controller.tick(clock.elapsedSeconds);
            return CustomPaint(
              size: Size.infinite,
              painter: _WordFieldPainter(words: controller.words, time: clock.elapsedSeconds),
            );
          },
        ),
      ),
    );
  }
}

class _WordFieldPainter extends CustomPainter {
  final List<WordParticle> words;
  final double time;
  _WordFieldPainter({required this.words, required this.time});

  @override
  void paint(Canvas canvas, Size size) {
    // Real, deliberate vertical band — "Upper 70% — almost entirely
    // empty. This is where spoken words temporarily exist" per
    // NATIVE_TRANSITION_BRIEF.md. Kept well clear of the orb/embers
    // in the lower 30% without touching the existing Column layout
    // at all — purely additive.
    final bandTop = size.height * 0.10;
    final bandHeight = size.height * 0.45;

    for (final w in words) {
      final age = time - w.spawnTime;
      if (age < 0 || age > WordFieldController.totalLifetime) continue;

      double opacity;
      if (age < WordFieldController.appearSeconds) {
        opacity = age / WordFieldController.appearSeconds;
      } else if (age < WordFieldController.appearSeconds + WordFieldController.holdSeconds) {
        opacity = 1.0;
      } else {
        final dissolveAge = age - WordFieldController.appearSeconds - WordFieldController.holdSeconds;
        opacity = 1.0 - (dissolveAge / WordFieldController.dissolveSeconds);
      }
      opacity = opacity.clamp(0.0, 1.0);
      if (opacity <= 0.0) continue;

      // Real, gentle upward drift — Rule 6 ("words drifting inward —
      // the Office is listening"). A small horizontal wobble, seeded
      // per word, so a multi-word transcript never reads as a rigid,
      // synchronised grid.
      final rise = age * 14.0;
      final wobble = math.sin(time * 0.6 + w.driftSeed) * 6.0;
      final baseY = bandTop + (bandHeight * ((w.x * 37) % 1.0));
      final position = Offset(w.x * size.width + wobble, baseY - rise);

      final textPainter = TextPainter(
        text: TextSpan(
          text: w.text,
          style: TextStyle(
            color: _wordTextColor.withOpacity(opacity * 0.9),
            fontSize: 15,
            fontWeight: FontWeight.w400,
            letterSpacing: 0.2,
          ),
        ),
        textDirection: TextDirection.ltr,
      )..layout();
      textPainter.paint(canvas, position - Offset(textPainter.width / 2, textPainter.height / 2));

      // Real dissolve gesture, Phase 1 scope — a few small, fading
      // sparks trailing from the word during its dissolve phase only,
      // reusing the same radial-gradient dot technique the ambient
      // spark field already uses, rather than simulating literal
      // per-letter fragment physics — deliberately deferred to a
      // later phase, not overbuilt now. Coloured to match the orb
      // itself, quietly foreshadowing Phase 2's gravity pull.
      final dissolveStart = WordFieldController.appearSeconds + WordFieldController.holdSeconds;
      if (age > dissolveStart) {
        final dissolveProgress = ((age - dissolveStart) / WordFieldController.dissolveSeconds).clamp(0.0, 1.0);
        for (var s = 0; s < 3; s++) {
          final sparkSeed = w.driftSeed + s * 2.1;
          final sparkOffset = Offset(
            math.cos(sparkSeed) * 10 * dissolveProgress,
            -math.sin(sparkSeed) * 10 * dissolveProgress - dissolveProgress * 8,
          );
          final sparkOpacity = (opacity * 0.7).clamp(0.0, 1.0);
          final sparkCenter = position + sparkOffset;
          final sparkPaint = Paint()
            ..shader = RadialGradient(
              colors: [_wordSparkColor.withOpacity(sparkOpacity), _wordSparkColor.withOpacity(0.0)],
            ).createShader(Rect.fromCircle(center: sparkCenter, radius: 3.5));
          canvas.drawCircle(sparkCenter, 2.0, sparkPaint);
        }
      }
    }
  }

  @override
  bool shouldRepaint(covariant _WordFieldPainter oldPainter) =>
      oldPainter.time != time || oldPainter.words.length != words.length;
}

// Kept local to this file rather than importing main.dart's private
// palette constants — Dart's leading-underscore privacy makes
// cross-file reuse of _textPrimary/_pulse impossible without
// exporting them, which isn't worth doing for two colors. Same real
// values as main.dart's _textPrimary (0xFFF5F5F5) and _pulse
// (0xFFE63946), duplicated deliberately, not drifted from memory.
const _wordTextColor = Color(0xFFF5F5F5);
const _wordSparkColor = Color(0xFFE63946);
