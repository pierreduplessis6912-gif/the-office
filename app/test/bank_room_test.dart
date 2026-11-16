// The bank room (lib/engine/bank_room.dart) and its parsers. Pinned: the reconciliation and this month's cash flow show the engine's own figures; open items on each side are listed; no statement and an
// unreadable answer each say so; a difference nothing explains is shown. Recorded client, no network.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:the_office/engine/assistant_model.dart';
import 'package:the_office/engine/engine_api.dart';
import 'package:the_office/engine/engine_fixtures.dart';
import 'package:the_office/engine/bank_room.dart';

class _BankApi extends FixtureEngineApi {
  final EngineResponse rec, flow;
  final EngineResponse? accounts;
  int reads = 0;
  _BankApi(Map<String, EngineResponse> fixtures, this.rec, this.flow, {this.accounts}) : super(fixtures);
  @override
  Future<EngineResponse> bankAccounts() async => accounts ?? await super.bankAccounts();
  @override
  Future<EngineResponse> bankReconciliation() async { reads++; return rec; }
  @override
  Future<EngineResponse> cashFlow(String period) async => flow;
}

EngineResponse _ok(Map<String, Object?> result) => EngineResponse(200, <String, Object?>{'status': 'ok', 'result': result});

Map<String, Object?> _rec({int unexplained = 0, bool reconciled = false, List<Object?>? outstanding, List<Object?>? unmatched}) => <String, Object?>{
      'statement': <String, Object?>{'id': 1, 'periodFrom': '2026-11-01', 'periodTo': '2026-11-30', 'openingMinor': 0, 'closingMinor': 188500},
      'ledgerMinor': 198500, 'statementMinor': 188500, 'unexplainedMinor': unexplained, 'reconciled': reconciled,
      'outstandingEntries': outstanding ?? <Object?>[<String, Object?>{'journalLineId': 4, 'date': '2026-11-12', 'amountMinor': 40000, 'memo': 'Payment received', 'party': 'Mokoena'}],
      'unmatchedLines': unmatched ?? <Object?>[<String, Object?>{'bankLineId': 4, 'date': '2026-11-14', 'description': 'Mystery deposit', 'amountMinor': 30000}],
    };

final _flow = _ok(<String, Object?>{
  'from': '2026-11-01', 'to': '2026-11-30', 'openingMinor': 70000,
  'inflows': [<String, Object?>{'name': 'Received from customers', 'amountMinor': 265000}],
  'outflows': [<String, Object?>{'name': 'Paid to suppliers and for expenses', 'amountMinor': 90000}],
  'netMinor': 175000, 'closingMinor': 245000, 'balanced': true,
});

Future<void> _open(WidgetTester tester, EngineApi api) async {
  await tester.pumpWidget(MaterialApp(home: Scaffold(body: BankRoom(key: UniqueKey(), api: api))));
  await tester.pump(const Duration(milliseconds: 100));
  await tester.pump(const Duration(milliseconds: 100));
}

void main() {
  final fixtures = engineResponsesFrom(engineFixtureJson);

  testWidgets('shows the books against the statement, what is open, and cash flow', (tester) async {
    await _open(tester, _BankApi(fixtures, _ok(_rec()), _flow));
    expect(find.text('R1,985.00'), findsOneWidget);
    expect(find.text('R1,885.00'), findsOneWidget);
    expect(find.textContaining('Mystery deposit'), findsOneWidget);
    expect(find.textContaining('Mokoena'), findsOneWidget);
    expect(find.text('Out: Paid to suppliers and for expenses'), findsOneWidget);
    expect(find.byKey(const Key('bank-reconciled')), findsNothing);
    expect(find.byKey(const Key('bank-unexplained')), findsNothing);
  });

  testWidgets('says so when reconciled, and when a difference is not explained', (tester) async {
    await _open(tester, _BankApi(fixtures, _ok(_rec(reconciled: true, outstanding: <Object?>[], unmatched: <Object?>[])), _flow));
    expect(find.byKey(const Key('bank-reconciled')), findsOneWidget);
    await _open(tester, _BankApi(fixtures, _ok(_rec(unexplained: -5000)), _flow));
    expect(find.byKey(const Key('bank-unexplained')), findsOneWidget);
    expect(find.text('-R50.00'), findsOneWidget);
  });

  testWidgets('says so when there is no statement, and when unreadable', (tester) async {
    await _open(tester, _BankApi(fixtures, _ok(<String, Object?>{'statement': null, 'reconciled': false}), _flow));
    expect(find.byKey(const Key('bank-no-statement')), findsOneWidget);
    final api = _BankApi(fixtures, const EngineResponse(500, null), const EngineResponse(500, null));
    await _open(tester, api);
    expect(find.byKey(const Key('bank-error')), findsOneWidget);
    await tester.tap(find.byKey(const Key('bank-refresh')));
    await tester.pump(const Duration(milliseconds: 100));
    expect(api.reads, 2);
  });

  test('parsers refuse what is not the engine shape', () {
    expect(parseBankRec(200, <String, Object?>{'status': 'ok', 'result': <String, Object?>{'statement': null}}), isNull);
    expect(bankRecHasNoStatement(200, <String, Object?>{'status': 'ok', 'result': <String, Object?>{'statement': null}}), isTrue);
    expect(bankRecHasNoStatement(500, null), isFalse);
    expect(parseCashFlow(200, <String, Object?>{'status': 'ok', 'result': <String, Object?>{}}), isNull);
  });

  testWidgets('lists the bank accounts with their balances when there is more than one, and says the statement check is for the main account', (tester) async {
    final accounts = _ok(<String, Object?>{
      'accounts': [
        <String, Object?>{'id': 1, 'code': '1000', 'name': 'Bank', 'isDefault': true, 'balanceMinor': 60000},
        <String, Object?>{'id': 9, 'code': '1020', 'name': 'Savings', 'isDefault': false, 'balanceMinor': 40000},
      ],
    });
    await _open(tester, _BankApi(engineResponsesFrom(engineFixtureJson), _ok(_rec()), _flow, accounts: accounts));
    expect(find.byKey(const Key('bank-account-1')), findsOneWidget);
    expect(find.byKey(const Key('bank-account-9')), findsOneWidget);
    expect(find.text('Savings'), findsOneWidget);
    expect(find.text('R400.00'), findsWidgets);
    expect(find.byKey(const Key('bank-main-only')), findsOneWidget);
  });

  testWidgets('shows no accounts section when there is only the main account', (tester) async {
    final accounts = _ok(<String, Object?>{
      'accounts': [<String, Object?>{'id': 1, 'code': '1000', 'name': 'Bank', 'isDefault': true, 'balanceMinor': 60000}],
    });
    await _open(tester, _BankApi(engineResponsesFrom(engineFixtureJson), _ok(_rec()), _flow, accounts: accounts));
    expect(find.byKey(const Key('bank-account-1')), findsNothing);
    expect(find.byKey(const Key('bank-main-only')), findsNothing);
  });

  test('the accounts parser keeps the rows it can read and says null for an unreadable answer', () {
    final list = parseBankAccounts(200, <String, Object?>{
      'status': 'ok',
      'result': <String, Object?>{'accounts': [<String, Object?>{'id': 1, 'name': 'Bank', 'isDefault': true, 'balanceMinor': 5}, <String, Object?>{'id': 2}]},
    });
    expect(list!.length, 1);
    expect(list.first.isDefault, isTrue);
    expect(parseBankAccounts(500, <String, Object?>{'error': 'x'}), isNull);
    expect(parseBankAccounts(200, <String, Object?>{'status': 'ok', 'result': <String, Object?>{}}), isNull);
  });
}
