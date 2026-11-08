// The engine shell's demo entry point (lib/engine_main.dart). What this pins: it runs the shell on the embedded RECORDED answers (no files, no network), says on screen that they are recorded and not a live business, and its menu switches
// who is asking and what the business has, so every honest answer can be seen. The embedded copy is kept equal to the engine by tools/slice-mokoena.test.js. It does not test the shader or layout on a device.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:the_office/engine/engine_api.dart';
import 'package:the_office/engine/engine_fixtures.dart';
import 'package:the_office/engine/engine_orb.dart';
import 'package:the_office/engine_main.dart' show EngineDemoApp;

Future<void> _ask(WidgetTester tester, String question) async {
  await tester.enterText(find.byKey(const Key('ask-field')), question);
  await tester.tap(find.byKey(const Key('ask-send')));
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 100));
}

Future<void> _choose(WidgetTester tester, String label) async {
  await tester.tap(find.byKey(const Key('demo-menu')));
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 300));
  await tester.tap(find.text(label));
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 300));
}

void main() {
  test('the embedded answers are all readable', () {
    final all = engineResponsesFrom(engineFixtureJson);
    expect(all.length, engineFixtureJson.length);
    expect(all.containsKey('receivables-answer'), isTrue);
    expect(all['receivables-answer']!.status, 200);
    expect(all['receivables-refused']!.status, 403);
    expect(all['unavailable-ask']!.status, 409);
  });

  testWidgets('it opens on the orb and says what it is running on', (tester) async {
    await tester.pumpWidget(const EngineDemoApp());
    await tester.pump(const Duration(milliseconds: 50));
    expect(find.byType(EngineOrb), findsOneWidget);
    expect(find.textContaining('Recorded engine answers, not a live business'), findsOneWidget);
    expect(find.textContaining('Accountant (can read and record)'), findsOneWidget);
  });

  testWidgets('a question is answered from the embedded answers', (tester) async {
    await tester.pumpWidget(const EngineDemoApp());
    await tester.pump(const Duration(milliseconds: 50));
    await _ask(tester, 'What does Mokoena owe me?');
    expect(find.text('R850.00'), findsOneWidget);
    expect(find.text('Invoice #1'), findsOneWidget);
  });

  testWidgets('the menu shows a restricted member, and the answer is a boundary with no figure', (tester) async {
    await tester.pumpWidget(const EngineDemoApp());
    await tester.pump(const Duration(milliseconds: 50));
    await _choose(tester, 'Installer (restricted)');
    expect(find.textContaining('Showing: Installer (restricted)'), findsOneWidget);
    await _ask(tester, 'What does Mokoena owe me?');
    expect(find.text('NOT AVAILABLE FOR YOUR ROLE'), findsOneWidget);
    expect(find.textContaining('R850'), findsNothing);
  });

  testWidgets('the menu shows a business without the capability, answered honestly', (tester) async {
    await tester.pumpWidget(const EngineDemoApp());
    await tester.pump(const Duration(milliseconds: 50));
    await _choose(tester, 'Business without the capability');
    await _ask(tester, 'What does Mokoena owe me?');
    expect(find.text('NOT AVAILABLE'), findsOneWidget);
    expect(find.byKey(const Key('answer-total')), findsNothing);
  });

  testWidgets('the whole journey runs on the embedded answers: ask, drill down, return, record R500, approve, R350.00', (tester) async {
    await tester.pumpWidget(const EngineDemoApp());
    await tester.pump(const Duration(milliseconds: 50));
    await _ask(tester, 'What does Mokoena owe me?');
    await tester.ensureVisible(find.byKey(const Key('open-document-1')));
    await tester.tap(find.byKey(const Key('open-document-1')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 100));
    expect(find.text('Invoice #1'), findsOneWidget);
    expect(find.byKey(const Key('room-title')), findsOneWidget);
    await tester.ensureVisible(find.byKey(const Key('room-conversation')));
    await tester.tap(find.byKey(const Key('room-conversation')));
    await tester.pump();
    expect(find.byKey(const Key('answer-total')), findsOneWidget);
    await _ask(tester, 'Record R500 from Mokoena');
    expect(find.text('AWAITING YOUR APPROVAL'), findsOneWidget);
    await tester.ensureVisible(find.byKey(const Key('approve')));
    await tester.tap(find.byKey(const Key('approve')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 100));
    expect(find.text('Recorded R500.00 from Mokoena.'), findsOneWidget);
    expect(find.text('R350.00'), findsOneWidget);
  });
}
