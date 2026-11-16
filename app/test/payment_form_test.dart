// The record-a-payment form (lib/engine/payment_form.dart). Pinned: it sends exactly the payload the assistant would (payment.record: partyId, amountMinor in whole cents, the customer's own currency, the
// date, method, the bank account when there is more than one and the method is not cash, allocate oldest first) to be HELD; it says what the customer owes from the engine's own figure; plain mistakes
// (no customer, an unclear amount, a customer with no invoices) are not sent; the engine's own reason is shown on a refusal; the "+" in the invoices room opens it. Recorded client, no network.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:the_office/engine/engine_api.dart';
import 'package:the_office/engine/engine_fixtures.dart';
import 'package:the_office/engine/invoices_room.dart';
import 'package:the_office/engine/payment_form.dart';

EngineResponse _ok(Map<String, Object?> result) => EngineResponse(200, <String, Object?>{'status': 'ok', 'result': result});

class _PayApi extends FixtureEngineApi {
  final EngineResponse answer;
  final bool twoAccounts;
  final bool noInvoices;
  _PayApi(Map<String, EngineResponse> fixtures, this.answer, {this.twoAccounts = false, this.noInvoices = false}) : super(fixtures);

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
  Future<EngineResponse> receivables(String party) async => noInvoices
      ? EngineResponse(200, <String, Object?>{'status': 'ok', 'result': <String, Object?>{'party': <String, Object?>{'id': 3, 'name': 'Mokoena'}, 'currency': null, 'totalMinor': 0, 'documents': <Object?>[], 'version': 1, 'derivedBy': 'x'}})
      : EngineResponse(200, <String, Object?>{
          'status': 'ok',
          'result': <String, Object?>{
            'party': <String, Object?>{'id': 3, 'name': 'Mokoena'},
            'currency': 'ZAR',
            'totalMinor': 138000,
            'documents': [<String, Object?>{'ref': <String, Object?>{'kind': 'document', 'id': 1}, 'number': 1, 'kind': 'invoice', 'issuedOn': '2026-10-01', 'grossMinor': 138000, 'allocatedMinor': 0, 'outstandingMinor': 138000}],
            'version': 1,
            'derivedBy': 'ledger.outstandingForParty',
          },
        });

  @override
  Future<EngineResponse> bankAccounts() async => twoAccounts
      ? _ok(<String, Object?>{
          'accounts': [
            <String, Object?>{'id': 1, 'code': '1000', 'name': 'Bank', 'isDefault': true, 'balanceMinor': 0},
            <String, Object?>{'id': 9, 'code': '1020', 'name': 'Savings', 'isDefault': false, 'balanceMinor': 0},
          ],
        })
      : _ok(<String, Object?>{
          'accounts': [<String, Object?>{'id': 1, 'code': '1000', 'name': 'Bank', 'isDefault': true, 'balanceMinor': 0}],
        });
}

const _held = EngineResponse(200, <String, Object?>{'status': 'held', 'actionId': 7, 'message': 'Waiting for approval.'});

Future<void> _open(WidgetTester tester, EngineApi api) async {
  await tester.pumpWidget(MaterialApp(home: Scaffold(body: PaymentForm(key: UniqueKey(), api: api, onClose: () {}, clock: () => DateTime(2026, 11, 16)))));
  await tester.pump();
  await tester.pump();
}

Future<void> _chooseCustomer(WidgetTester tester) async {
  await tester.tap(find.byKey(const Key('payment-form-customer')));
  await tester.pumpAndSettle();
  await tester.tap(find.text('Mokoena').last);
  await tester.pumpAndSettle();
}

void main() {
  final fixtures = engineResponsesFrom(engineFixtureJson);

  testWidgets('lists only customers, shows what the chosen customer owes, and sends the exact payload to be held', (tester) async {
    final api = _PayApi(fixtures, _held);
    await _open(tester, api);
    await tester.tap(find.byKey(const Key('payment-form-customer')));
    await tester.pumpAndSettle();
    expect(find.text('Timber Supplies'), findsNothing);
    await tester.tap(find.text('Mokoena').last);
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('payment-form-owes')), findsOneWidget);
    expect(find.text('Owes R1,380.00'), findsOneWidget);
    await tester.enterText(find.byKey(const Key('payment-form-amount')), 'R450.50');
    await tester.tap(find.byKey(const Key('payment-form-send')));
    await tester.pump();
    await tester.pump();
    expect(api.proposed.length, 1);
    expect(api.proposed.first['capability'], 'payment.record');
    expect(api.proposed.first['payload'], <String, Object?>{
      'partyId': 3,
      'amountMinor': 45050,
      'currency': 'ZAR',
      'occurredOn': '2026-11-16',
      'method': 'eft',
      'allocate': 'oldest_first',
    });
    expect(find.byKey(const Key('payment-form-sent')), findsOneWidget);
  });

  testWidgets('with two bank accounts it asks which one and sends it; cash never names one', (tester) async {
    final api = _PayApi(fixtures, _held, twoAccounts: true);
    await _open(tester, api);
    await _chooseCustomer(tester);
    expect(find.byKey(const Key('payment-form-account')), findsOneWidget);
    await tester.tap(find.byKey(const Key('payment-form-account')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Savings').last);
    await tester.pumpAndSettle();
    await tester.enterText(find.byKey(const Key('payment-form-amount')), '100');
    await tester.tap(find.byKey(const Key('payment-form-send')));
    await tester.pump();
    await tester.pump();
    expect((api.proposed.first['payload'] as Map)['bankAccountId'], 9);
  });

  testWidgets('with one bank account there is no account question', (tester) async {
    final api = _PayApi(fixtures, _held);
    await _open(tester, api);
    expect(find.byKey(const Key('payment-form-account')), findsNothing);
  });

  testWidgets('no customer, an unclear amount, or a customer with no invoices is not sent', (tester) async {
    final api = _PayApi(fixtures, _held);
    await _open(tester, api);
    await tester.tap(find.byKey(const Key('payment-form-send')));
    await tester.pump();
    expect(find.text('Choose the customer first.'), findsOneWidget);
    await _chooseCustomer(tester);
    await tester.enterText(find.byKey(const Key('payment-form-amount')), '450.555');
    await tester.tap(find.byKey(const Key('payment-form-send')));
    await tester.pump();
    expect(find.text('Type the amount in rand, for example 450.00.'), findsOneWidget);
    expect(api.proposed, isEmpty);
    final none = _PayApi(fixtures, _held, noInvoices: true);
    await _open(tester, none);
    await _chooseCustomer(tester);
    await tester.enterText(find.byKey(const Key('payment-form-amount')), '100');
    await tester.tap(find.byKey(const Key('payment-form-send')));
    await tester.pump();
    expect(find.text('Mokoena has no invoices yet, so there is nothing to pay.'), findsOneWidget);
    expect(none.proposed, isEmpty);
  });

  testWidgets("shows the engine's reason when it refuses", (tester) async {
    final api = _PayApi(fixtures, const EngineResponse(422, <String, Object?>{'error': 'over_allocated', 'message': 'The allocations add up to more than the payment.'}));
    await _open(tester, api);
    await _chooseCustomer(tester);
    await tester.enterText(find.byKey(const Key('payment-form-amount')), '100');
    await tester.tap(find.byKey(const Key('payment-form-send')));
    await tester.pump();
    await tester.pump();
    expect(find.text('The allocations add up to more than the payment.'), findsOneWidget);
    expect(find.byKey(const Key('payment-form-sent')), findsNothing);
  });

  testWidgets('the plus in the invoices room opens the form', (tester) async {
    final api = _PayApi(fixtures, _held);
    await tester.pumpWidget(MaterialApp(home: Scaffold(body: InvoicesRoom(key: UniqueKey(), api: api))));
    await tester.pump(const Duration(milliseconds: 100));
    await tester.tap(find.byKey(const Key('invoices-pay')));
    await tester.pump();
    await tester.pump();
    expect(find.byKey(const Key('payment-form-customer')), findsOneWidget);
  });
}
