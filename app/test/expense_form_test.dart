// The record-an-expense form (lib/engine/expense_form.dart). Pinned: it sends exactly the payload the assistant would (expense.record: supplier, dates, method, category, ZAR, whether the amount includes VAT,
// whether the tax invoice is held, the amount in whole cents, one line at 15% or 0%) to be HELD; the bank account is asked only with more than one account and never for cash; plain mistakes are not sent;
// the engine's own reason is shown; the "+" in the expenses room opens it. Recorded client, no network.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:the_office/engine/engine_api.dart';
import 'package:the_office/engine/engine_fixtures.dart';
import 'package:the_office/engine/expense_form.dart';
import 'package:the_office/engine/expenses_room.dart';

EngineResponse _ok(Map<String, Object?> result) => EngineResponse(200, <String, Object?>{'status': 'ok', 'result': result});

class _ExpApi extends FixtureEngineApi {
  final EngineResponse answer;
  final bool twoAccounts;
  _ExpApi(Map<String, EngineResponse> fixtures, this.answer, {this.twoAccounts = false}) : super(fixtures);

  @override
  Future<EngineResponse> propose(String capability, Map<String, Object?> payload, String transcript) async {
    await super.propose(capability, payload, transcript);
    return answer;
  }

  @override
  Future<EngineResponse> parties({String? role}) async => _ok(<String, Object?>{
        'parties': [
          <String, Object?>{'id': 3, 'name': 'Mokoena', 'kind': 'person', 'roles': ['customer']},
          <String, Object?>{'id': 4, 'name': 'Timber Supplies', 'kind': 'organisation', 'roles': ['supplier']},
        ],
        'count': 2,
      });

  @override
  Future<EngineResponse> bankAccounts() async => _ok(<String, Object?>{
        'accounts': [
          <String, Object?>{'id': 1, 'code': '1000', 'name': 'Bank', 'isDefault': true, 'balanceMinor': 0},
          if (twoAccounts) <String, Object?>{'id': 9, 'code': '1020', 'name': 'Savings', 'isDefault': false, 'balanceMinor': 0},
        ],
      });
}

const _held = EngineResponse(200, <String, Object?>{'status': 'held', 'actionId': 7, 'message': 'Waiting for approval.'});

Future<void> _open(WidgetTester tester, EngineApi api) async {
  await tester.pumpWidget(MaterialApp(home: Scaffold(body: ExpenseForm(key: UniqueKey(), api: api, onClose: () {}, clock: () => DateTime(2026, 11, 16)))));
  await tester.pump();
  await tester.pump();
}

Future<void> _chooseSupplier(WidgetTester tester) async {
  await tester.tap(find.byKey(const Key('expense-form-supplier')));
  await tester.pumpAndSettle();
  await tester.tap(find.text('Timber Supplies').last);
  await tester.pumpAndSettle();
}

Future<void> _send(WidgetTester tester) async {
  await tester.ensureVisible(find.byKey(const Key('expense-form-send')));
  await tester.tap(find.byKey(const Key('expense-form-send')));
  await tester.pump();
  await tester.pump();
}

void main() {
  final fixtures = engineResponsesFrom(engineFixtureJson);

  testWidgets('lists only suppliers and sends the exact payload to be held', (tester) async {
    final api = _ExpApi(fixtures, _held);
    await _open(tester, api);
    await tester.tap(find.byKey(const Key('expense-form-supplier')));
    await tester.pumpAndSettle();
    expect(find.text('Mokoena'), findsNothing);
    await tester.tap(find.text('Timber Supplies').last);
    await tester.pumpAndSettle();
    await tester.enterText(find.byKey(const Key('expense-form-amount')), 'R1 150');
    await tester.enterText(find.byKey(const Key('expense-form-what')), 'Skirting boards');
    await _send(tester);
    expect(api.proposed.length, 1);
    expect(api.proposed.first['capability'], 'expense.record');
    expect(api.proposed.first['payload'], <String, Object?>{
      'supplierId': 4,
      'incurredOn': '2026-11-16',
      'paidOn': '2026-11-16',
      'method': 'eft',
      'category': 'other',
      'currency': 'ZAR',
      'amountsIncludeTax': true,
      'taxInvoiceHeld': true,
      'amountPaidMinor': 115000,
      'lines': [
        <String, Object?>{'description': 'Skirting boards', 'amountMinor': 115000, 'taxBp': 1500},
      ],
    });
    expect(find.byKey(const Key('expense-form-sent')), findsOneWidget);
  });

  testWidgets('no VAT sends rate 0 and never says the amount includes VAT; the description falls back to the category', (tester) async {
    final api = _ExpApi(fixtures, _held);
    await _open(tester, api);
    await _chooseSupplier(tester);
    await tester.enterText(find.byKey(const Key('expense-form-amount')), '80');
    await tester.ensureVisible(find.byKey(const Key('expense-form-vat')));
    await tester.tap(find.byKey(const Key('expense-form-vat')));
    await tester.pump();
    expect(find.byKey(const Key('expense-form-includes')), findsNothing);
    await _send(tester);
    final p = api.proposed.first['payload'] as Map;
    expect(p['amountsIncludeTax'], false);
    expect(((p['lines'] as List).first as Map)['taxBp'], 0);
    expect(((p['lines'] as List).first as Map)['description'], 'other');
  });

  testWidgets('the bank account is asked only with two accounts', (tester) async {
    final one = _ExpApi(fixtures, _held);
    await _open(tester, one);
    expect(find.byKey(const Key('expense-form-account')), findsNothing);
    final two = _ExpApi(fixtures, _held, twoAccounts: true);
    await _open(tester, two);
    await _chooseSupplier(tester);
    await tester.ensureVisible(find.byKey(const Key('expense-form-account')));
    await tester.tap(find.byKey(const Key('expense-form-account')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Savings').last);
    await tester.pumpAndSettle();
    await tester.enterText(find.byKey(const Key('expense-form-amount')), '100');
    await _send(tester);
    expect((two.proposed.first['payload'] as Map)['bankAccountId'], 9);
  });

  testWidgets('no supplier or an unclear amount is not sent', (tester) async {
    final api = _ExpApi(fixtures, _held);
    await _open(tester, api);
    await _send(tester);
    expect(find.text('Choose the supplier first.'), findsOneWidget);
    await _chooseSupplier(tester);
    await tester.enterText(find.byKey(const Key('expense-form-amount')), '12.345');
    await _send(tester);
    expect(find.text('Type the amount in rand, for example 450.00.'), findsOneWidget);
    expect(api.proposed, isEmpty);
  });

  testWidgets("shows the engine's reason when it refuses", (tester) async {
    final api = _ExpApi(fixtures, const EngineResponse(422, <String, Object?>{'error': 'invalid', 'message': 'category must be one of advertising, fuel.'}));
    await _open(tester, api);
    await _chooseSupplier(tester);
    await tester.enterText(find.byKey(const Key('expense-form-amount')), '100');
    await _send(tester);
    expect(find.text('category must be one of advertising, fuel.'), findsOneWidget);
    expect(find.byKey(const Key('expense-form-sent')), findsNothing);
  });

  testWidgets('the plus in the expenses room opens the form', (tester) async {
    final api = _ExpApi(fixtures, _held);
    await tester.pumpWidget(MaterialApp(home: Scaffold(body: ExpensesRoom(key: UniqueKey(), api: api))));
    await tester.pump(const Duration(milliseconds: 100));
    await tester.tap(find.byKey(const Key('expenses-add')));
    await tester.pump();
    await tester.pump();
    expect(find.byKey(const Key('expense-form-supplier')), findsOneWidget);
  });
}
