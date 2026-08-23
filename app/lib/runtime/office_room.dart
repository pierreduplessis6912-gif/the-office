import 'package:flutter/material.dart';

import 'office_state.dart';

/// The Office Runtime — real room materialization, per Rule 8 of
/// DESIGN_CONSTITUTION_V2.md: "Stop thinking in navigation. Think
/// architecture... a room opens. Not a popup. Not a chat bubble. Not
/// a toast. The relevant world quietly appears... when finished, the
/// room closes. The Office returns."
///
/// Deliberately not a standard [showModalBottomSheet] (which slides
/// up from an edge — a real, different visual language than
/// "materializing"). Uses [showGeneralDialog]'s own, real
/// [transitionBuilder] support for a genuine fade + soft scale
/// entrance, and drives the real [OfficeStateMachine] through
/// RoomOpening while opening and RoomClosing while dismissing, so the
/// state machine's own states have something real to represent
/// rather than sitting permanently unwired.
///
/// Real, direct feedback: "the ember becomes a doorway... the room
/// should be born from the ember, not appear as a generic modal."
/// [origin] is the real, on-screen position of whatever was tapped to
/// open this room (an ember, a menu item) - when given, the room
/// genuinely grows outward from that point rather than the screen's
/// center. Optional and falls back to centered scaling, so existing
/// callers keep working unchanged until they have a real origin to
/// pass.
///
/// Real, direct feedback: "that same colour becomes the first light
/// of the room." [accentColor], when given alongside [origin], adds a
/// real, animated colored glow at the same point during the opening
/// transition - the same colour the ignition sequence ended on
/// continues here rather than cutting to a generic black barrier, so
/// the two read as one continuous event.
Future<T?> showOfficeRoom<T>({
  required BuildContext context,
  required OfficeStateMachine officeState,
  required WidgetBuilder builder,
  Offset? origin,
  Color? accentColor,
}) {
  officeState.transitionTo(OfficeState.roomOpening);
  final screenSize = MediaQuery.of(context).size;
  // Real conversion from a screen-space pixel Offset to Alignment's
  // own -1..1 space (0,0 is center) - only computed when a real
  // origin was actually given.
  final alignment = origin == null
      ? Alignment.center
      : Alignment(
          (origin.dx / screenSize.width) * 2 - 1,
          (origin.dy / screenSize.height) * 2 - 1,
        );
  return showGeneralDialog<T>(
    context: context,
    barrierLabel: 'Room',
    barrierColor: Colors.black.withOpacity(0.72),
    transitionDuration: const Duration(milliseconds: 420),
    pageBuilder: (context, animation, secondaryAnimation) {
      // Real, deliberate ordering: the room is fully open (Idle) once
      // its own entrance transition has actually finished, not the
      // instant it's requested - RoomOpening should genuinely last as
      // long as the opening motion does.
      if (animation.status == AnimationStatus.completed) {
        officeState.transitionTo(OfficeState.idle);
      }
      // Real, confirmed fix: showGeneralDialog, unlike
      // showModalBottomSheet, does not wrap its content in a Material
      // widget automatically - the exact, real, structural difference
      // between every room built here (which all showed a pervasive
      // underline artifact) and the app's older sheets (which never
      // did). Without a real Material ancestor, Text falls back to
      // Flutter's own root DefaultTextStyle, which includes
      // decoration: TextDecoration.underline as a genuine, built-in
      // signal that something's structurally missing. Wrapping in
      // Material gives real, proper theme inheritance, the same as
      // every other part of this app already has for free.
      return Material(
        color: Colors.transparent,
        child: Builder(builder: builder),
      );
    },
    transitionBuilder: (context, animation, secondaryAnimation, child) {
      final curved = CurvedAnimation(parent: animation, curve: Curves.easeOutCubic, reverseCurve: Curves.easeInCubic);
      if (animation.status == AnimationStatus.reverse && officeState.state != OfficeState.roomClosing) {
        officeState.transitionTo(OfficeState.roomClosing);
      }
      final scaled = FadeTransition(
        opacity: curved,
        child: ScaleTransition(
          // Real, direct feedback: grows from the real, tapped
          // origin point rather than always the generic center -
          // 0.06 (not the previous 0.94) since growing from a small,
          // real point reads correctly starting much smaller.
          // Real bug, found live: a pervasive underline artifact
          // appeared on all text, first noticed in People, also
          // present in Finance - the one, exact code path both share.
          // Removing .blur() alone did not fix it (confirmed on real
          // device) - removing the entire flutter_animate chain here
          // as a decisive test of whether the package itself, in this
          // usage, is responsible, rather than continuing to guess at
          // individual effects within it. Reverts to the plain,
          // originally-proven scale/fade only for the entrance.
          alignment: alignment,
          scale: Tween<double>(begin: origin == null ? 0.94 : 0.06, end: 1.0).animate(curved),
          child: child,
        ),
      );
      if (accentColor == null || origin == null) return scaled;
      return Stack(
        children: [
          scaled,
          // Real, animated colored glow at the same origin - peaks
          // early (continuing the ignition's own final brightness),
          // then recedes as the room's real content takes over, so
          // the same colour genuinely becomes the room's first light
          // rather than a sharp cut to black.
          IgnorePointer(
            child: AnimatedBuilder(
              animation: animation,
              builder: (context, _) {
                final t = animation.value;
                final glowOpacity = (1.0 - t).clamp(0.0, 1.0) * 0.4;
                if (glowOpacity <= 0.0) return const SizedBox.shrink();
                return Positioned(
                  left: origin.dx - 300,
                  top: origin.dy - 300,
                  child: Container(
                    width: 600,
                    height: 600,
                    decoration: BoxDecoration(
                      shape: BoxShape.circle,
                      gradient: RadialGradient(
                        colors: [accentColor.withOpacity(glowOpacity), accentColor.withOpacity(0.0)],
                      ),
                    ),
                  ),
                );
              },
            ),
          ),
        ],
      );
    },
  ).whenComplete(() {
    officeState.transitionTo(OfficeState.idle);
  });
}
