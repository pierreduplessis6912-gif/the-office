// The bills room (lib/engine/bills_room.dart) and its parser (parseBillList). Pinned: each bill still to be paid shows its supplier, the supplier's invoice number, the due date, what is still owed and the bill
// total, in the engine's own figures; an empty list and an unreadable one each say so. Read only: a bill is recorded or paid through a held proposal the person approves. Recorded client, no network.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:the_office/engine/assistant_model.dart';
import 'package:the_office/engine/bills_room.dart';
import 'package:the_office/engine/engine_api.dart';
import 'package:the_office/engine/engine_fixtures.dart';

class _BillsApi extends FixtureEngineApi {
  final EngineResponse answer;
  int reads = 0;
  _BillsApi(Map<String, EngineResponse> fixtures, this.answer) : super(fixtures);
  @override
  Future<EngineResponse> bills() async {
    reads++;
    return answer;
  }
}

Map<String, Object?> _row(int id, String supplier, String number, String due, int gross, int owing) =>
    <String, Object?>{'id': id, 'supplierName': supplier, 'supplierInvoiceNumber': number, 'dueOn': due, 'grossMinor': gross, 'outstandingMinor': owing, 'status': 'unpaid'};

EngineResponse _ok(List<Object?> rows) => EngineResponse(200, <String, Object?>{'status': 'ok', 'result': <String, Object?>{'bills': rows, 'count': rows.length}});

Future<void> _open(WidgetTester tester, EngineApi api) async {
  await tester.pumpWidget(MaterialApp(home: Scaffold(body: BillsRoom(key: UniqueKey(), api: api))));
  await tester.pump(const Duration(milliseconds: 100));
  await tester.pump(const Duration(milliseconds: 100));
}

void main() {
  final fixtures = engineResponsesFrom(engineFixtureJson);

  test('the parser keeps the rows it can read and says null for an unreadable answer', () {
    final rows = parseBillList(200, <String, Object?>{'status': 'ok', 'result': <String, Object?>{'bills': <Object?>[_row(1, 'Timber Supplies', 'INV-1', '2026-12-01', 115000, 115000), <String, Object?>{'id': 2}]}});
    expect(rows!.map((r) => r.id).toList(), <int>[1]);
    expect(rows.first.outstandingMinor, 115000);
    expect(parseBillList(500, <String, Object?>{'error': 'x'}), isNull);
    expect(parseBillList(200, 'nonsense'), isNull);
    expect(parseBillList(200, <String, Object?>{'status': 'ok', 'result': <String, Object?>{'bills': <Object?>[]}}), isEmpty);
  });

  testWidgets('each bill shows supplier, invoice number, due date, what is owed and the total', (tester) async {
    await _open(tester, _BillsApi(fixtures, _ok(<Object?>[_row(1, 'Timber Supplies', 'INV-1', '2026-12-01', 115000, 115000), _row(2, 'Hardware Hub', 'HH-1', '2026-12-05', 172500, 72500)])));
    expect(find.byKey(const Key('bill-row-1')), findsOneWidget);
    expect(find.byKey(const Key('bill-row-2')), findsOneWidget);
    expect(find.textContaining('Timber Supplies'), findsOneWidget);
    expect(find.textContaining('INV-1'), findsOneWidget);
    expect(find.textContaining('2026-12-01'), findsOneWidget);
    expect(find.text('R1,150.00 owed'), findsOneWidget);
    expect(find.text('R725.00 owed'), findsOneWidget);
    expect(find.textContaining('of R1,725.00'), findsOneWidget);
  });

  testWidgets('an empty list and an unreadable answer each say so, and refresh reads again', (tester) async {
    final empty = _BillsApi(fixtures, _ok(<Object?>[]));
    await _open(tester, empty);
    expect(find.byKey(const Key('bills-empty')), findsOneWidget);
    await tester.tap(find.byKey(const Key('bills-refresh')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 100));
    expect(empty.reads, 2);
    await _open(tester, _BillsApi(fixtures, const EngineResponse(500, null)));
    expect(find.byKey(const Key('bills-error')), findsOneWidget);
  });
}
