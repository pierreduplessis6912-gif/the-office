// Front-end slice 3: reduced motion and screen-reader labels.
//
// Reduced motion follows the phone's own setting (Android "Remove animations", iOS "Reduce Motion"), which Flutter reports as
// disableAnimations. When it is on, the things that move on their own (the void, the orb's glow and filaments, the embers' drift, the
// ambient sparks, the opening fade, the light that gathers into a reply) hold still, and everything that carries information still
// appears. When it is off, nothing here changes anything.
//
// Labels: a few controls were bare gesture areas, so a screen reader could neither name nor use them. A11yButton gives one a name and a
// tap action; A11yLive makes the spoken reply announce itself; emberLabel names an ember with what it holds.
import 'package:flutter/widgets.dart';

/// True when the phone asks apps to remove animations. Reads the setting through MediaQuery, so a widget that calls it in build is
/// rebuilt when the person changes the setting.
bool reducedMotion(BuildContext context) => MediaQuery.maybeDisableAnimationsOf(context) ?? false;

/// The same question for code that is not building (an event, a timer). Not reactive.
bool reducedMotionNow() => WidgetsBinding.instance.platformDispatcher.accessibilityFeatures.disableAnimations;

/// The seconds a moving thing should be drawn at: the real clock normally, a fixed moment (0) when motion is reduced.
double motionSeconds(BuildContext context, double elapsedSeconds) => reducedMotion(context) ? 0.0 : elapsedSeconds;

/// "Tasks, 3 waiting", or just "Tasks" when nothing is waiting.
String emberLabel(String room, int count) => count > 0 ? '$room, $count waiting' : room;

/// Names a tappable thing for a screen reader and gives it a tap action.
/// [replaceChild] true (the default) makes the label stand in for whatever the child would say; false keeps the child's own
/// semantics (its tap action) and only adds the name.
class A11yButton extends StatelessWidget {
  const A11yButton({super.key, required this.label, required this.child, this.onTap, this.selected, this.replaceChild = true});
  final String label;
  final Widget child;
  final VoidCallback? onTap;
  final bool? selected;
  final bool replaceChild;

  @override
  Widget build(BuildContext context) =>
      Semantics(button: true, label: label, selected: selected, onTap: onTap, excludeSemantics: replaceChild, child: child);
}

/// Marks its child as a live region: a screen reader announces it when it appears or changes.
class A11yLive extends StatelessWidget {
  const A11yLive({super.key, required this.child});
  final Widget child;

  @override
  Widget build(BuildContext context) => Semantics(liveRegion: true, child: child);
}
