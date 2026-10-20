// Front-end slice 3 (lib/accessibility.dart). What this pins: the reduced-motion question is answered from the phone's own setting (through
// MediaQuery for widgets, through the platform for code that is not building); a moving thing is drawn at a fixed moment only when motion is
// reduced; an ember is named with what it holds; and the two wrappers give a screen reader a named, tappable button and a live region.
// It does not pin how the void, orb or embers look: that needs a device.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:the_office/accessibility.dart';

Widget _app(Widget child, {bool reduce = false}) =>
    MediaQuery(data: MediaQueryData(disableAnimations: reduce), child: Directionality(textDirection: TextDirection.ltr, child: child));

void main() {
  testWidgets('reducedMotion follows the setting, and defaults to off with no MediaQuery', (tester) async {
    bool? seen;
    await tester.pumpWidget(_app(Builder(builder: (c) { seen = reducedMotion(c); return const SizedBox(); }), reduce: true));
    expect(seen, isTrue);
    await tester.pumpWidget(_app(Builder(builder: (c) { seen = reducedMotion(c); return const SizedBox(); })));
    expect(seen, isFalse);
    await tester.pumpWidget(Directionality(textDirection: TextDirection.ltr, child: Builder(builder: (c) { seen = reducedMotion(c); return const SizedBox(); })));
    expect(seen, isFalse);
  });

  testWidgets('a widget that asks is rebuilt when the setting changes', (tester) async {
    var builds = 0;
    Widget probe(bool reduce) => _app(Builder(builder: (c) { builds++; reducedMotion(c); return const SizedBox(); }), reduce: reduce);
    await tester.pumpWidget(probe(false));
    final before = builds;
    await tester.pumpWidget(probe(true));
    expect(builds, greaterThan(before));
  });

  testWidgets('motionSeconds is the real time normally and a fixed moment when motion is reduced', (tester) async {
    double? t;
    await tester.pumpWidget(_app(Builder(builder: (c) { t = motionSeconds(c, 12.5); return const SizedBox(); })));
    expect(t, 12.5);
    await tester.pumpWidget(_app(Builder(builder: (c) { t = motionSeconds(c, 12.5); return const SizedBox(); }), reduce: true));
    expect(t, 0.0);
  });

  testWidgets('reducedMotionNow reads the platform setting', (tester) async {
    expect(reducedMotionNow(), isFalse);
    tester.platformDispatcher.accessibilityFeaturesTestValue = const FakeAccessibilityFeatures(disableAnimations: true);
    addTearDown(tester.platformDispatcher.clearAccessibilityFeaturesTestValue);
    expect(reducedMotionNow(), isTrue);
  });

  test('an ember is named with what it holds', () {
    expect(emberLabel('Tasks', 3), 'Tasks, 3 waiting');
    expect(emberLabel('Finance', 1), 'Finance, 1 waiting');
    expect(emberLabel('People', 0), 'People');
  });

  testWidgets('A11yButton is a named button that a screen reader can tap', (tester) async {
    final handle = tester.ensureSemantics();
    var taps = 0;
    await tester.pumpWidget(_app(A11yButton(label: 'Talk to The Office', onTap: () => taps++, child: const SizedBox(width: 96, height: 96))));
    expect(tester.getSemantics(find.byType(A11yButton)), containsSemantics(label: 'Talk to The Office', isButton: true, hasTapAction: true));
    tester.semantics.tap(find.semantics.byLabel('Talk to The Office'));
    expect(taps, 1);
    handle.dispose();
  });

  testWidgets('A11yButton says whether a chip is selected', (tester) async {
    final handle = tester.ensureSemantics();
    await tester.pumpWidget(_app(A11yButton(label: 'Overdue', selected: true, onTap: () {}, child: const Text('OVERDUE'))));
    expect(tester.getSemantics(find.byType(A11yButton)), containsSemantics(label: 'Overdue', isButton: true, hasSelectedState: true, isSelected: true));
    handle.dispose();
  });

  testWidgets('with replaceChild false the child keeps its own tap and the button adds the name', (tester) async {
    final handle = tester.ensureSemantics();
    var taps = 0;
    await tester.pumpWidget(_app(A11yButton(
      label: 'Tasks, 2 waiting',
      replaceChild: false,
      child: GestureDetector(onTap: () => taps++, child: const SizedBox(width: 32, height: 32)),
    )));
    expect(tester.getSemantics(find.byType(A11yButton)), containsSemantics(label: 'Tasks, 2 waiting', isButton: true, hasTapAction: true));
    tester.semantics.tap(find.semantics.byLabel('Tasks, 2 waiting'));
    expect(taps, 1);
    handle.dispose();
  });

  testWidgets('A11yLive marks its text as a live region', (tester) async {
    final handle = tester.ensureSemantics();
    await tester.pumpWidget(_app(const A11yLive(child: Text('Invoice 1042 is paid'))));
    expect(tester.getSemantics(find.byType(A11yLive)), containsSemantics(label: 'Invoice 1042 is paid', isLiveRegion: true));
    handle.dispose();
  });
}
