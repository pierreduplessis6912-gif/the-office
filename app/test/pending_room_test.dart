// The pending-approvals room (lib/engine/pending_room.dart) and the list parser (parseHeldList in assistant_model.dart). What this pins: every engine action waiting for a person is listed with what would be approved,
// in the engine's own figures; an action that is not the engine's (a legacy one) is not listed; Approve and Decline reach the engine and say what happened in plain words; a refusal is shown and the action stays
// listed; an empty list says so; a list that cannot be read says so. Nothing is computed here. Recorded client, no network.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:the_office/engine/assistant_model.dart';
import 'package:the_office/engine/engine_api.dart';
import 'package:the_office/engine/engine_fixtures.dart';
import 'package:the_office/engine/pending_room.dart';

class _PendingApi extends FixtureEngineApi {
  List<Map<String, Object?>> items;
  final List<int> confirmed = <int>[];
  final List<int> rejected = <int>[];
  EngineResponse? confirmAnswer;
  EngineResponse? pendingAnswer;
  _PendingApi(Map<String, EngineResponse> fixtures, this.items) : super(fixtures);

  @override
  Future<EngineResponse> pending() async => pendingAnswer ?? EngineResponse(200, <String, Object?>{'pending': items});

  @override
  Future<EngineResponse> confirm(int actionId) async {
    confirmed.add(actionId);
    final answer = confirmAnswer;
    if (answer != null) return answer;
    items = items.where((i) => i['id'] != actionId).toList();
    return const EngineResponse(200, <String, Object?>{'status': 'confirmed'});
  }

  @override
  Future<EngineResponse> reject(int actionId) async {
    rejected.add(actionId);
    items = items.where((i) => i['id'] != actionId).toList();
    return const EngineResponse(200, <String, Object?>{'status': 'rejected'});
  }

  @override
  Future<EngineResponse> record(String kind, int id) async => const EngineResponse(404, <String, Object?>{'error': 'not_found'});
}

Map<String, Object?> _party(int id, String name) => <String, Object?>{
      'id': id,
      'type': 'engine.party.create',
      'payload': '{"kind":"organisation","name":"$name","roles":["supplier"]}',
      'source_transcript': 'Add $name as a supplier',
    };

Future<void> _open(WidgetTester tester, EngineApi api) async {
  await tester.pumpWidget(MaterialApp(home: Scaffold(body: PendingRoom(api: api))));
  await tester.pump(const Duration(milliseconds: 100));
  await tester.pump(const Duration(milliseconds: 100));
}

void main() {
  final fixtures = engineResponsesFrom(engineFixtureJson);

  test('the list parser keeps the engine actions only, in the order the engine gave them', () {
    final held = parseHeldList(200, <String, Object?>{
      'pending': <Object?>[
        _party(7, 'Acme Ltd'),
        <String, Object?>{'id': 8, 'type': 'invoice.create', 'payload': '{}', 'source_transcript': 'legacy'},
        _party(9, 'Beta Ltd'),
        <String, Object?>{'id': 10, 'type': 'engine.party.create', 'payload': 'not json', 'source_transcript': 'broken'},
      ],
    });
    expect(held.map((h) => h.id).toList(), <int>[7, 9]);
    expect(parseHeldList(500, <String, Object?>{'pending': <Object?>[]}), isEmpty);
    expect(parseHeldList(200, 'nonsense'), isEmpty);
  });

  testWidgets('each waiting action is listed with what would be approved and what the person said', (tester) async {
    await _open(tester, _PendingApi(fixtures, <Map<String, Object?>>[_party(7, 'Acme Ltd'), _party(9, 'Beta Ltd')]));
    expect(find.byKey(const Key('pending-7')), findsOneWidget);
    expect(find.byKey(const Key('pending-9')), findsOneWidget);
    expect(find.text('Acme Ltd'), findsOneWidget);
    expect(find.text('Beta Ltd'), findsOneWidget);
    expect(find.textContaining('Add Acme Ltd as a supplier'), findsOneWidget);
    expect(find.text('Add a customer or supplier'), findsNWidgets(2));
  });

  testWidgets('an empty list says nothing is waiting', (tester) async {
    await _open(tester, _PendingApi(fixtures, <Map<String, Object?>>[]));
    expect(find.byKey(const Key('pending-empty')), findsOneWidget);
    expect(find.textContaining('Nothing is waiting'), findsOneWidget);
  });

  testWidgets('a list that cannot be read says so', (tester) async {
    final api = _PendingApi(fixtures, <Map<String, Object?>>[])..pendingAnswer = const EngineResponse(500, <String, Object?>{'error': 'x'});
    await _open(tester, api);
    expect(find.byKey(const Key('pending-error')), findsOneWidget);
  });

  testWidgets('Approve reaches the engine, says it is recorded and the action leaves the list', (tester) async {
    final api = _PendingApi(fixtures, <Map<String, Object?>>[_party(7, 'Acme Ltd'), _party(9, 'Beta Ltd')]);
    await _open(tester, api);
    await tester.tap(find.byKey(const Key('pending-approve-7')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 100));
    await tester.pump(const Duration(milliseconds: 100));
    expect(api.confirmed, <int>[7]);
    expect(find.byKey(const Key('pending-7')), findsNothing);
    expect(find.byKey(const Key('pending-9')), findsOneWidget);
    expect(find.textContaining('Done: it is now recorded.'), findsOneWidget);
  });

  testWidgets('Decline reaches the engine and nothing is recorded', (tester) async {
    final api = _PendingApi(fixtures, <Map<String, Object?>>[_party(7, 'Acme Ltd')]);
    await _open(tester, api);
    await tester.tap(find.byKey(const Key('pending-decline-7')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 100));
    await tester.pump(const Duration(milliseconds: 100));
    expect(api.rejected, <int>[7]);
    expect(api.confirmed, isEmpty);
    expect(find.textContaining('Declined: nothing was recorded.'), findsOneWidget);
  });

  testWidgets('a refusal is shown in the engine\'s words and the action stays listed', (tester) async {
    final api = _PendingApi(fixtures, <Map<String, Object?>>[_party(7, 'Acme Ltd')])
      ..confirmAnswer = const EngineResponse(409, <String, Object?>{'error': 'stale', 'message': 'That changed since it was proposed, so nothing was done.'});
    await _open(tester, api);
    await tester.tap(find.byKey(const Key('pending-approve-7')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 100));
    await tester.pump(const Duration(milliseconds: 100));
    expect(find.textContaining('That changed since it was proposed'), findsOneWidget);
    expect(find.byKey(const Key('pending-7')), findsOneWidget);
  });
}
