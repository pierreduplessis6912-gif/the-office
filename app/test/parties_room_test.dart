// The customers and suppliers room (lib/engine/parties_room.dart) and its parser (parsePartyList). Pinned: every party the engine lists is shown with its name, whether it is a customer or a supplier and its contact
// details when there are any; tapping a customer shows what they still owe, invoice by invoice, in the engine's own figures (the existing receivables read, parsed by parseReceivables); a supplier is not opened here (its
// bills are in the bills room); an empty list, an unreadable one and a customer whose figures cannot be read each say so. Read only. Recorded client, no network.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:the_office/engine/assistant_model.dart';
import 'package:the_office/engine/engine_api.dart';
import 'package:the_office/engine/engine_fixtures.dart';
import 'package:the_office/engine/parties_room.dart';

class _PartiesApi extends FixtureEngineApi {
  final EngineResponse answer;
  final EngineResponse owed;
  int reads = 0;
  String? asked;
  _PartiesApi(Map<String, EngineResponse> fixtures, this.answer, [this.owed = const EngineResponse(500, null)]) : super(fixtures);
  @override
  Future<EngineResponse> parties({String? role}) async {
    reads++;
    return answer;
  }

  @override
  Future<EngineResponse> receivables(String party) async {
    asked = party;
    return owed;
  }
}

Map<String, Object?> _row(int id, String name, List<String> roles, {String? email, String? phone}) =>
    <String, Object?>{'id': id, 'name': name, 'kind': 'organisation', 'roles': roles, 'contact': <String, Object?>{if (email != null) 'email': email, if (phone != null) 'phone': phone}};

EngineResponse _ok(List<Object?> rows) => EngineResponse(200, <String, Object?>{'status': 'ok', 'result': <String, Object?>{'parties': rows, 'count': rows.length}});

EngineResponse _owed() => const EngineResponse(200, <String, Object?>{
      'status': 'ok',
      'result': <String, Object?>{
        'party': <String, Object?>{'id': 1, 'name': 'Mokoena'},
        'currency': 'ZAR',
        'totalMinor': 230000,
        'version': 3,
        'derivedBy': 'ledger.outstandingForParty',
        'documents': <Object?>[
          <String, Object?>{'ref': <String, Object?>{'kind': 'document', 'id': 9}, 'number': 12, 'kind': 'invoice', 'issuedOn': '2026-11-01', 'grossMinor': 230000, 'allocatedMinor': 0, 'outstandingMinor': 230000},
        ],
      },
    });

Future<void> _open(WidgetTester tester, EngineApi api) async {
  await tester.pumpWidget(MaterialApp(home: Scaffold(body: PartiesRoom(key: UniqueKey(), api: api))));
  await tester.pump(const Duration(milliseconds: 100));
  await tester.pump(const Duration(milliseconds: 100));
}

void main() {
  final fixtures = engineResponsesFrom(engineFixtureJson);

  test('the parser keeps the rows it can read, reads roles and contact, and says null for an unreadable answer', () {
    final rows = parsePartyList(200, <String, Object?>{'status': 'ok', 'result': <String, Object?>{'parties': <Object?>[_row(1, 'Mokoena', <String>['customer'], email: 'm@x.co.za'), <String, Object?>{'id': 2}]}});
    expect(rows!.map((r) => r.id).toList(), <int>[1]);
    expect(rows.first.isCustomer, isTrue);
    expect(rows.first.email, 'm@x.co.za');
    expect(parsePartyList(500, <String, Object?>{'error': 'x'}), isNull);
    expect(parsePartyList(200, 'nonsense'), isNull);
    expect(parsePartyList(200, <String, Object?>{'status': 'ok', 'result': <String, Object?>{'parties': <Object?>[]}}), isEmpty);
  });

  testWidgets('each party shows its name, role and contact details', (tester) async {
    await _open(tester, _PartiesApi(fixtures, _ok(<Object?>[_row(1, 'Mokoena', <String>['customer'], email: 'm@x.co.za', phone: '082 000 0000'), _row(2, 'Timber Supplies', <String>['supplier'])])));
    expect(find.byKey(const Key('party-row-1')), findsOneWidget);
    expect(find.byKey(const Key('party-row-2')), findsOneWidget);
    expect(find.text('Customer'), findsOneWidget);
    expect(find.text('Supplier'), findsOneWidget);
    expect(find.textContaining('m@x.co.za'), findsOneWidget);
    expect(find.textContaining('082 000 0000'), findsOneWidget);
  });

  testWidgets('tapping a customer shows what they owe, invoice by invoice, and back returns to the list', (tester) async {
    final api = _PartiesApi(fixtures, _ok(<Object?>[_row(1, 'Mokoena', <String>['customer'])]), _owed());
    await _open(tester, api);
    await tester.tap(find.byKey(const Key('party-row-1')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 100));
    expect(api.asked, '1');
    expect(find.textContaining('Invoice #12'), findsOneWidget);
    expect(find.textContaining('2026-11-01'), findsOneWidget);
    expect(find.text('R2,300.00 owed'), findsNWidgets(2));
    await tester.tap(find.byKey(const Key('party-back')));
    await tester.pump();
    expect(find.byKey(const Key('party-row-1')), findsOneWidget);
  });

  testWidgets('a customer whose figures cannot be read says so; a supplier is not opened', (tester) async {
    final api = _PartiesApi(fixtures, _ok(<Object?>[_row(1, 'Mokoena', <String>['customer']), _row(2, 'Timber Supplies', <String>['supplier'])]));
    await _open(tester, api);
    await tester.tap(find.byKey(const Key('party-row-2')));
    await tester.pump();
    expect(api.asked, isNull);
    await tester.tap(find.byKey(const Key('party-row-1')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 100));
    expect(find.byKey(const Key('party-owed-error')), findsOneWidget);
  });

  testWidgets('an empty list and an unreadable answer each say so, and refresh reads again', (tester) async {
    final empty = _PartiesApi(fixtures, _ok(<Object?>[]));
    await _open(tester, empty);
    expect(find.byKey(const Key('parties-empty')), findsOneWidget);
    await tester.tap(find.byKey(const Key('parties-refresh')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 100));
    expect(empty.reads, 2);
    await _open(tester, _PartiesApi(fixtures, const EngineResponse(500, null)));
    expect(find.byKey(const Key('parties-error')), findsOneWidget);
  });
}
