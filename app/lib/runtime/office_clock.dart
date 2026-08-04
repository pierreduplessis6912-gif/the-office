import 'package:flutter/scheduler.dart';

/// The Office Runtime — Engine Clock.
///
/// Real, single source of timing for the whole runtime. Per
/// OFFICE_RUNTIME_V1.md: "One engine clock... single source of
/// timing, delta time, elapsed time." Everything that currently
/// drives its own, independent AnimationController (each ember, the
/// orb's breathe cycle, the spark field) should read time from here
/// instead — so the whole simulation ticks together, not as several
/// unrelated clocks that happen to share a screen.
///
/// Built on a real, low-level [Ticker] rather than an
/// [AnimationController] — a Ticker is the actual primitive Flutter
/// uses to drive per-frame callbacks with a genuine elapsed
/// [Duration], with no artificial "duration" or repeat/reverse
/// semantics of its own to fight against. It just ticks, forever,
/// once started.
class OfficeClock extends ChangeNotifier {
  OfficeClock({required TickerProvider vsync}) {
    _ticker = vsync.createTicker(_onTick);
  }

  late final Ticker _ticker;

  /// Real elapsed time since the clock started, in seconds. The
  /// single, authoritative "now" every system should read from,
  /// rather than each computing its own via
  /// DateTime.now().millisecondsSinceEpoch or an independent
  /// AnimationController's own value.
  double elapsedSeconds = 0;

  /// Real time since the previous tick, in seconds. Present for
  /// systems that need frame-rate-independent motion (velocity *
  /// deltaSeconds) rather than assuming a fixed frame interval.
  double deltaSeconds = 0;

  bool _isPaused = false;
  bool get isPaused => _isPaused;

  void start() {
    if (!_ticker.isTicking) _ticker.start();
  }

  /// Real pause - the ticker itself keeps running (so resuming is
  /// instant and drift-free), but elapsedSeconds/deltaSeconds simply
  /// stop advancing. Systems reading the clock see time genuinely
  /// stand still, matching the runtime's own "Idle... breathing...
  /// alive" default rather than an app that's silently frozen.
  void pause() => _isPaused = true;
  void resume() => _isPaused = false;

  void _onTick(Duration elapsed) {
    if (_isPaused) return;
    final newElapsedSeconds = elapsed.inMicroseconds / Duration.microsecondsPerSecond;
    deltaSeconds = (newElapsedSeconds - elapsedSeconds).clamp(0.0, 0.25);
    elapsedSeconds = newElapsedSeconds;
    notifyListeners();
  }

  @override
  void dispose() {
    _ticker.dispose();
    super.dispose();
  }
}
