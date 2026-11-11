// The assistant screen (lib/engine/assistant_panel.dart) on the engine's recorded answers. What this pins: a typed sentence brings the engine's own answer (a lookup, the VAT summary), a write is HELD and shown with exactly what the approver
// would approve, nothing says "recorded" until the person approves, approving and declining reach the engine, and every honest refusal is shown. It does not test layout or the shader: that needs a device.
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:the_office/engine/assistant_panel.dart';
import 'package:the_office/engine/engine_api.dart';

late Map<String, EngineResponse> _fx;

Future<void> _open(WidgetTester tester, EngineApi api) async {
  await tester.pumpWidget(MaterialApp(home: Scaffold(body: AssistantPanel(api: api, footnote: 'Recorded engine answers.'))));
  await tester.pump(const Duration(milliseconds: 50));
}

Future<void> _ask(WidgetTester tester, String text) async {
  await tester.enterText(find.byKey(const Key('assistant-field')), text);
  await tester.tap(find.byKey(const Key('assistant-send')));
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 100));
  await tester.pump(const Duration(milliseconds: 100));
}

Future<void> _tap(WidgetTester tester, Finder finder) async {
  await tester.ensureVisible(finder);
  await tester.pump();
  await tester.tap(finder);
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 100));
}

void main() {
  setUpAll(() {
    _fx = <String, EngineResponse>{};
    for (final f in Directory('test/fixtures/slice').listSync().whereType<File>()) {
      if (!f.path.endsWith('.json')) continue;
      final parsed = EngineResponse.fromFixtureJson(f.readAsStringSync());
      if (parsed != null) _fx[f.uri.pathSegments.last.replaceAll('.json', '')] = parsed;
    }
  });

  testWidgets('it opens empty, with the field and what it is running on', (tester) async {
    await _open(tester, FixtureEngineApi(_fx));
    expect(find.byKey(const Key('assistant-field')), findsOneWidget);
    expect(find.text('Recorded engine answers.'), findsOneWidget);
    expect(find.textContaining('Approve'), findsNothing);
  });

  testWidgets('a lookup brings the engine\'s answer', (tester) async {
    await _open(tester, FixtureEngineApi(_fx));
    await _ask(tester, 'Who is Patel?');
    expect(find.byKey(const Key('party-2')), findsOneWidget);
    expect(find.text('Patel Builders'), findsOneWidget);
  });

  testWidgets('the VAT summary shows the period and the engine\'s figures', (tester) async {
    await _open(tester, FixtureEngineApi(_fx));
    await _ask(tester, 'What is my VAT this month?');
    expect(find.textContaining('VAT 2026-10-01 to 2026-10-31'), findsOneWidget);
    expect(find.textContaining('Output tax (field 4)'), findsOneWidget);
    expect(find.textContaining('Net VAT'), findsOneWidget);
  });

  testWidgets('an expense is HELD with exactly what would be approved, and nothing is recorded yet', (tester) async {
    final api = FixtureEngineApi(_fx);
    await _open(tester, api);
    await _ask(tester, 'Bought plywood from Timber Supplies for R230 including VAT, paid by EFT, I have the invoice');
    expect(find.text('Record an expense'), findsOneWidget);
    expect(find.text('Timber Supplies'), findsOneWidget);          // named by a record read, not invented
    expect(find.text('R230.00'), findsWidgets);
    expect(find.text('R30.00'), findsOneWidget);                    // the engine's tax, not worked out here
    expect(find.text('Nothing is recorded until you approve it.'), findsOneWidget);
    expect(find.byKey(const Key('approve-2')), findsOneWidget);
    expect(find.byKey(const Key('decline-2')), findsOneWidget);
    expect(find.byKey(const Key('decision-line')), findsNothing);
    expect(api.confirmations, isEmpty);
  });

  testWidgets('approving reaches the engine and says it is recorded', (tester) async {
    final api = FixtureEngineApi(_fx);
    await _open(tester, api);
    await _ask(tester, 'Bought plywood from Timber Supplies for R230 including VAT, paid by EFT, I have the invoice');
    await _tap(tester, find.byKey(const Key('approve-2')));
    expect(api.confirmations, <int>[2]);
    expect(find.text('Done: it is now recorded.'), findsOneWidget);
    expect(find.byKey(const Key('approve-2')), findsNothing);       // it cannot be approved twice
  });

  testWidgets('declining reaches the engine and says nothing was recorded', (tester) async {
    final api = FixtureEngineApi(_fx);
    await _open(tester, api);
    await _ask(tester, 'Add Dlamini Timber as a supplier');
    expect(find.text('Add a customer or supplier'), findsOneWidget);
    expect(find.text('Dlamini Timber'), findsWidgets);
    await _tap(tester, find.byKey(const Key('decline-1')));
    expect(api.rejections, <int>[1]);
    expect(find.text('Declined: nothing was recorded.'), findsOneWidget);
  });

  testWidgets('a sentence the engine does not understand is answered honestly', (tester) async {
    await _open(tester, FixtureEngineApi(_fx));
    await _ask(tester, 'Lock the tax period up to the end of last month');
    expect(find.textContaining('did not understand'), findsOneWidget);
    expect(find.textContaining('Approve'), findsNothing);
  });

  testWidgets('an unknown supplier is refused in the engine\'s words', (tester) async {
    await _open(tester, FixtureEngineApi(_fx));
    await _ask(tester, 'Bought glue from Nobody Ltd for R100 including VAT');
    expect(find.textContaining('There is no supplier called Nobody Ltd'), findsOneWidget);
  });

  testWidgets('a restricted member is refused', (tester) async {
    await _open(tester, FixtureEngineApi(_fx, role: 'installer'));
    await _ask(tester, 'Who is Patel?');
    expect(find.byKey(const Key('party-2')), findsNothing);
    expect(find.textContaining('needs permission'), findsOneWidget);
  });
}
