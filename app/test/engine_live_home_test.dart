// The live engine screen (lib/engine/engine_live_home.dart): shown by main.dart only when the server says the signed-in business is an engine business (docs/decisions/app-connection.md, decision 2).
// What this pins: it builds its client from the address and the session it is given and nothing else; it has the two rooms (what is owed, the assistant); the assistant has the capture buttons; signing out
// is the person's own button and calls back; the client is never built from anything but those two values. It uses the recorded answers through the factory: no network.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:the_office/engine/assistant_panel.dart' show EngineCaptureFile;
import 'package:the_office/engine/engine_api.dart';
import 'package:the_office/engine/engine_fixtures.dart';
import 'package:the_office/engine/engine_live_home.dart';

void main() {
  final fixtures = engineResponsesFrom(engineFixtureJson);

  Widget app({EngineApiFactory? factory, VoidCallback? onSignOut, Future<EngineCaptureFile?> Function()? pickPhoto}) {
    return MaterialApp(
      home: EngineLiveHome(
        baseUrl: 'https://example.test',
        sessionToken: 'tok-123',
        onSignOut: onSignOut ?? () {},
        apiFactory: factory ?? (String b, String t) => FixtureEngineApi(fixtures),
        pickPhoto: pickPhoto,
      ),
    );
  }

  testWidgets('the client is built from the address and the session it was given, once', (tester) async {
    var built = 0;
    String? gotBase;
    String? gotToken;
    await tester.pumpWidget(app(factory: (String b, String t) {
      built++;
      gotBase = b;
      gotToken = t;
      return FixtureEngineApi(fixtures);
    }));
    await tester.pump(const Duration(milliseconds: 100));
    expect(gotBase, 'https://example.test');
    expect(gotToken, 'tok-123');
    expect(built, 1);
  });

  testWidgets('it has the two rooms, and the assistant has the capture buttons', (tester) async {
    await tester.pumpWidget(app());
    await tester.pump(const Duration(milliseconds: 100));
    expect(find.byKey(const Key('live-tabs')), findsOneWidget);
    expect(find.descendant(of: find.byKey(const Key('live-tabs')), matching: find.text('What is owed')), findsOneWidget);
    await tester.tap(find.descendant(of: find.byKey(const Key('live-tabs')), matching: find.text('Assistant')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
    expect(find.byKey(const Key('assistant-field')), findsOneWidget);
    expect(find.byKey(const Key('capture-photo')), findsOneWidget);
    expect(find.byKey(const Key('capture-receipt')), findsOneWidget);
    expect(find.byKey(const Key('capture-bill')), findsOneWidget);
  });

  testWidgets('the third room lists what is waiting for approval', (tester) async {
    await tester.pumpWidget(app());
    await tester.pump(const Duration(milliseconds: 100));
    await tester.tap(find.descendant(of: find.byKey(const Key('live-tabs')), matching: find.text('To approve')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
    expect(find.byKey(const Key('pending-refresh')), findsOneWidget);
  });

  testWidgets('the fourth room lists the expenses', (tester) async {
    await tester.pumpWidget(app());
    await tester.pump(const Duration(milliseconds: 100));
    await tester.tap(find.descendant(of: find.byKey(const Key('live-tabs')), matching: find.text('Expenses')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
    expect(find.byKey(const Key('expenses-refresh')), findsOneWidget);
  });

  testWidgets('signing out is the person\'s own button and calls back', (tester) async {
    var out = 0;
    await tester.pumpWidget(app(onSignOut: () => out++));
    await tester.pump(const Duration(milliseconds: 100));
    expect(out, 0);
    await tester.tap(find.byKey(const Key('live-sign-out')));
    await tester.pump();
    expect(out, 1);
  });
}
