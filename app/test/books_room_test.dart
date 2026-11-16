// The books room (lib/engine/books_room.dart) and its parsers. Pinned: profit and loss, the balance sheet and the reconciliation show the engine's own figures; nothing booked says so; an unreadable answer says so.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:the_office/engine/assistant_model.dart';
import 'package:the_office/engine/engine_api.dart';
import 'package:the_office/engine/engine_fixtures.dart';
import 'package:the_office/engine/books_room.dart';

class _BooksApi extends FixtureEngineApi {
  final EngineResponse profit, balance, recon;
  int reads = 0;
  _BooksApi(Map<String, EngineResponse> fixtures, this.profit, this.balance, this.recon) : super(fixtures);
  @override
  Future<EngineResponse> profitAndLoss(String period) async { reads++; return profit; }
  @override
  Future<EngineResponse> balanceSheet() async => balance;
  @override
  Future<EngineResponse> reconciliation() async => recon;
}

EngineResponse _ok(Map<String, Object?> result) => EngineResponse(200, <String, Object?>{'status': 'ok', 'result': result});
const _bad = EngineResponse(500, null);

final _profit = _ok(<String, Object?>{
  'from': '2026-11-01', 'to': '2026-11-30',
  'income': [<String, Object?>{'code': '4000', 'name': 'Sales', 'amountMinor': 1000000}],
  'costOfSales': [<String, Object?>{'code': '5000', 'name': 'Cost of sales', 'amountMinor': 400000}],
  'expenses': [<String, Object?>{'code': '6000', 'name': 'Fuel', 'amountMinor': 100000}],
  'totals': <String, Object?>{'incomeMinor': 1000000, 'costOfSalesMinor': 400000, 'grossProfitMinor': 600000, 'expensesMinor': 100000, 'profitMinor': 500000},
});
final _balance = _ok(<String, Object?>{
  'asOf': '2026-11-16',
  'assets': [<String, Object?>{'code': '1000', 'name': 'Bank', 'amountMinor': 700000}],
  'liabilities': [<String, Object?>{'code': '2000', 'name': 'Accounts payable', 'amountMinor': 200000}],
  'equity': <Object?>[], 'earningsMinor': 500000,
  'totals': <String, Object?>{'assetsMinor': 700000, 'liabilitiesMinor': 200000, 'equityMinor': 0, 'liabilitiesAndEquityMinor': 700000},
  'balanced': true,
});
final _agree = _ok(<String, Object?>{'lines': [<String, Object?>{'label': 'Receivable', 'ledgerMinor': 1, 'recordsMinor': 1, 'differenceMinor': 0}], 'agrees': true});

Future<void> _open(WidgetTester tester, EngineApi api) async {
  await tester.pumpWidget(MaterialApp(home: Scaffold(body: BooksRoom(key: UniqueKey(), api: api))));
  await tester.pump(const Duration(milliseconds: 100));
  await tester.pump(const Duration(milliseconds: 100));
}

void main() {
  testWidgets('shows the engine figures', (tester) async {
    await _open(tester, _BooksApi(engineResponsesFrom(engineFixtureJson), _profit, _balance, _agree));
    expect(find.text('R5,000.00'), findsWidgets);
    expect(find.text('Sales'), findsOneWidget);
    expect(find.byKey(const Key('books-agrees')), findsOneWidget);
  });

  testWidgets('says so when nothing is booked', (tester) async {
    final emptyP = _ok(<String, Object?>{'from': 'a', 'to': 'b', 'income': <Object?>[], 'costOfSales': <Object?>[], 'expenses': <Object?>[], 'totals': <String, Object?>{'incomeMinor': 0, 'grossProfitMinor': 0, 'profitMinor': 0}});
    final emptyB = _ok(<String, Object?>{'asOf': 'c', 'assets': <Object?>[], 'liabilities': <Object?>[], 'equity': <Object?>[], 'earningsMinor': 0, 'totals': <String, Object?>{'assetsMinor': 0}, 'balanced': true});
    await _open(tester, _BooksApi(engineResponsesFrom(engineFixtureJson), emptyP, emptyB, _agree));
    expect(find.byKey(const Key('books-empty')), findsOneWidget);
  });

  testWidgets('says so when unreadable, and refresh reads again', (tester) async {
    final api = _BooksApi(engineResponsesFrom(engineFixtureJson), _bad, _bad, _bad);
    await _open(tester, api);
    expect(find.byKey(const Key('books-error')), findsOneWidget);
    await tester.tap(find.byKey(const Key('books-refresh')));
    await tester.pump(const Duration(milliseconds: 100));
    expect(api.reads, 2);
  });

  test('parsers refuse what is not the engine shape', () {
    expect(parseProfit(200, <String, Object?>{'status': 'ok', 'result': <String, Object?>{}}), isNull);
    expect(parseBalance(500, null), isNull);
    expect(parseReconciliation(200, <String, Object?>{'status': 'ok', 'result': <String, Object?>{'lines': 5}}), isNull);
  });
}
