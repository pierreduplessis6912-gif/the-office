// The invoices room (lib/engine/invoices_room.dart) and its parser (parseInvoiceList). Pinned: each invoice shows its customer, number, issue date, total and what is still owed (or Paid), the engine's own total owing
// is shown, an empty list and an unreadable one each say so. Read only. Recorded client, no network.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:the_office/engine/assistant_model.dart';
import 'package:the_office/engine/engine_api.dart';
import 'package:the_office/engine/engine_fixtures.dart';
import 'package:the_office/engine/invoices_room.dart';

class _InvoicesApi extends FixtureEngineApi {
  final EngineResponse answer;
  int reads = 0;
  _InvoicesApi(Map<String, EngineResponse> fixtures, this.answer) : super(fixtures);
  @override
  Future<EngineResponse> invoices() async {
    reads++;
    return answer;
  }
}

Map<String, Object?> _row(int id, int number, String party, String issued, int gross, int outstanding) =>
    <String, Object?>{'id': id, 'number': number, 'partyName': party, 'issuedOn': issued, 'grossMinor': gross, 'outstandingMinor': outstanding};

EngineResponse _ok(List<Object?> rows, int owing, {bool truncated = false}) =>
    EngineResponse(200, <String, Object?>{'status': 'ok', 'result': <String, Object?>{'invoices': rows, 'count': rows.length, 'owingMinor': owing, 'truncated': truncated}});

Future<void> _open(WidgetTester tester, EngineApi api) async {
  await tester.pumpWidget(MaterialApp(home: Scaffold(body: InvoicesRoom(key: UniqueKey(), api: api))));
  await tester.pump(const Duration(milliseconds: 100));
  await tester.pump(const Duration(milliseconds: 100));
}

void main() {
  final fixtures = engineResponsesFrom(engineFixtureJson);

  test('the parser keeps the rows it can read and says null for an unreadable answer', () {
    final list = parseInvoiceList(200, <String, Object?>{
      'status': 'ok',
      'result': <String, Object?>{'invoices': <Object?>[_row(2, 2, 'Mokoena', '2026-10-15', 23000, 23000), <String, Object?>{'id': 3}], 'owingMinor': 23000, 'truncated': false}
    });
    expect(list!.rows.map((r) => r.id).toList(), <int>[2]);
    expect(list.owingMinor, 23000);
    expect(parseInvoiceList(500, <String, Object?>{'error': 'x'}), isNull);
    expect(parseInvoiceList(200, <String, Object?>{'status': 'ok', 'result': <String, Object?>{'invoices': <Object?>[]}}), isNull);
  });

  testWidgets('shows each invoice, what is owing or Paid, and the engine total', (tester) async {
    await _open(tester, _InvoicesApi(fixtures, _ok(<Object?>[_row(2, 2, 'Mokoena', '2026-10-15', 23000, 23000), _row(1, 1, 'Mokoena', '2026-10-01', 115000, 0)], 23000)));
    expect(find.byKey(const Key('invoice-row-2')), findsOneWidget);
    expect(find.byKey(const Key('invoice-row-1')), findsOneWidget);
    expect(find.text('Mokoena · #2'), findsOneWidget);
    expect(find.text('Paid'), findsOneWidget);
    expect(find.text('Owing R230.00'), findsOneWidget);
    expect(find.text('Owing in total: R230.00'), findsOneWidget);
    expect(find.byKey(const Key('invoices-truncated')), findsNothing);
  });

  testWidgets('shows the due date, and says overdue only when the engine does', (tester) async {
    final api = _InvoicesApi(fixtures, _ok(<Object?>[
      <String, Object?>{..._row(3, 3, 'Mokoena', '2026-11-10', 115000, 115000), 'dueOn': '2026-11-15', 'overdue': true},
      <String, Object?>{..._row(2, 2, 'Dlamini', '2026-11-10', 23000, 23000), 'dueOn': '2026-12-31', 'overdue': false},
      _row(1, 1, 'Sipho', '2026-10-01', 5000, 5000),
    ], 143000));
    await _open(tester, api);
    expect(find.text('Overdue: was due 2026-11-15'), findsOneWidget);
    expect(find.text('Due 2026-12-31'), findsOneWidget);
    expect(find.byKey(const Key('invoice-due-1')), findsNothing, reason: 'no recorded due date, nothing shown and nothing worked out');
    final list = parseInvoiceList(200, <String, Object?>{'status': 'ok', 'result': <String, Object?>{'invoices': <Object?>[_row(1, 1, 'A', '2026-10-01', 1, 1)], 'owingMinor': 1, 'truncated': false}});
    expect(list!.rows.first.dueOn, '');
    expect(list.rows.first.overdue, isFalse);
  });

  testWidgets('says so when the list is cut at 50', (tester) async {
    await _open(tester, _InvoicesApi(fixtures, _ok(<Object?>[_row(1, 1, 'Mokoena', '2026-10-01', 1000, 1000)], 1000, truncated: true)));
    expect(find.byKey(const Key('invoices-truncated')), findsOneWidget);
  });

  testWidgets('says so when there are no invoices', (tester) async {
    await _open(tester, _InvoicesApi(fixtures, _ok(<Object?>[], 0)));
    expect(find.byKey(const Key('invoices-empty')), findsOneWidget);
  });

  testWidgets('says so when the answer cannot be read, and checks again', (tester) async {
    final api = _InvoicesApi(fixtures, EngineResponse(500, <String, Object?>{'error': 'x'}));
    await _open(tester, api);
    expect(find.byKey(const Key('invoices-error')), findsOneWidget);
    await tester.tap(find.byKey(const Key('invoices-refresh')));
    await tester.pump();
    expect(api.reads, 2);
  });
}
