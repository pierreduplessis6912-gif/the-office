import 'dart:async';
import 'package:flutter/foundation.dart';

/// The Office Runtime — real, named states, exactly as scoped in
/// OFFICE_RUNTIME_V1.md. "Visual behaviour comes from state
/// transitions. Not from arbitrary animation calls." Nothing outside
/// this file should ever call an AnimationController directly again
/// once systems are migrated onto this - they read the current state
/// and render accordingly.
enum OfficeState {
  /// The real, default 95%-of-the-time state. Breathing, warm, alive
  /// - Rule 5 of DESIGN_CONSTITUTION_V2.md, "even doing nothing, The
  /// Office should feel alive."
  idle,

  /// Peter is actively speaking; the orb grows, embers move slightly
  /// inward, the world is paying attention.
  listening,

  /// Real stillness, then one ember brightens - no spinner, ever.
  /// See DECISIONS.md's real, direct feedback on this exact point.
  thinking,

  /// A real response is being delivered - words appearing, per Rule 3
  /// ("the home screen has no memory"), before they dissolve.
  responding,

  /// A room (the reframed sheets/drawer, per Rule 8) is opening -
  /// materializing around Peter rather than navigating to a new
  /// screen.
  roomOpening,

  /// A room is closing - Peter returns to the one, calm Office.
  roomClosing,

  /// A real, guarded action is in flight - a confirm/reject request,
  /// an upload, a real network call whose outcome Peter is waiting
  /// on beyond the initial "thinking" delay.
  executing,
}

/// Real, minimal events - only for state that a bare enum value can't
/// carry on its own (an actual response's text, a specific word to
/// display and let dissolve). Deliberately not a generic, named-event
/// catalog for every possible occurrence in the app - OFFICE_RUNTIME_V1.md
/// is explicit that even the capability layer stays a single
/// "Current Capability" slot until real examples earn a generalized
/// shape; the same discipline applies here. Add a new event only when
/// a real system genuinely needs payload data the state transition
/// itself doesn't carry.
@immutable
sealed class OfficeEvent {
  const OfficeEvent();
}

/// A real word (or short fragment) to display and let dissolve, per
/// Rule 3 - "words drifting inward... the Office is listening."
final class WordSpoken extends OfficeEvent {
  const WordSpoken(this.text);
  final String text;
}

/// A real response has arrived and should be shown.
final class ResponseReceived extends OfficeEvent {
  const ResponseReceived(this.text);
  final String text;
}

/// A specific ember (by its real domain id - tasks/scheduler/finance/
/// suppliers/pending) was chosen as the one currently thinking, or
/// stopped thinking. Carries the real id since more than one system
/// (EmberSystem, and potentially others later) may care which one.
final class EmberThinkingChanged extends OfficeEvent {
  const EmberThinkingChanged(this.emberId);
  final String? emberId;
}

/// The Office Runtime — State Machine.
///
/// The single, authoritative source of truth for what the app is
/// currently doing. A ChangeNotifier so existing Flutter widgets can
/// listen the same, ordinary way they already listen to anything
/// else - no new state-management package, matching this project's
/// own, repeated principle of minimal footprint and avoiding
/// dependency risk introduced without real, demonstrated need.
class OfficeStateMachine extends ChangeNotifier {
  OfficeState _state = OfficeState.idle;
  OfficeState get state => _state;

  final _eventController = StreamController<OfficeEvent>.broadcast();

  /// Real systems subscribe here for payload-carrying events (a word
  /// to render, a response to show) rather than polling state.
  Stream<OfficeEvent> get events => _eventController.stream;

  /// Real, deliberate transition - no validation of "allowed"
  /// transitions in v1. OFFICE_RUNTIME_V1.md scopes this milestone as
  /// clock + state machine + event bus + render pipeline with
  /// existing systems migrated on - transition-graph validation is a
  /// real, separate concern to add only once a genuine need for it
  /// appears (an actual bug from an invalid transition), not
  /// speculatively now.
  void transitionTo(OfficeState next) {
    if (_state == next) return;
    _state = next;
    notifyListeners();
  }

  void emit(OfficeEvent event) {
    _eventController.add(event);
  }

  @override
  void dispose() {
    _eventController.close();
    super.dispose();
  }
}
