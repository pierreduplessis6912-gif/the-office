// The refund-an-overpayment form (lib/engine/refund_form.dart) and the overpayment parser. Pinned: it lists only what the engine lists, with how much is left; picking one fills the whole amount; it sends exactly
// payment.refund {paymentId, amountMinor, refundedOn, method} to be HELD; more than is left, no choice or an unclear amount is not sent; the engine's own reason is shown; an empty list says so; the refund button in the
// invoices room opens it. Recorded client, no network.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:the_office/engine/assistant_model.dart';
import 'package:the_office/engine/engine_api.dart';
import 'package:the_office/engine/engine_fixtures.dart';
import 'package:the_office/engine/invoices_room.dart';
import 'package:the_office/engine/refund_form.dart';

class _RApi extends FixtureEngineApi {
  final EngineResponse answer;
  final List<Object?> payments;
  final bool twoAccounts;
  _RApi(Map<String, EngineResponse> fixtures, this.answer, {this.twoAccounts = false, this.payments = const <Object?>[
    <String, Object?>{'ref': {'kind': 'movement', 'id': 5}, 'id': 5, 'partyId': 3, 'partyName': 'Mokoena', 'currency': 'ZAR', 'receivedOn': '2026-11-01', 'availableMinor': 25050},
    <String, Object?>{'ref': {'kind': 'movement', 'id': 6}, 'id': 6, 'partyId': 4, 'partyName': 'Dlamini', 'currency': 'ZAR', 'receivedOn': '2026-11-05', 'availableMinor': 10000},
  ]}) : super(fixtures);

  @override
  Future<EngineResponse> propose(String capability, Map<String, Object?> payload, String transcript) async {
    await super.propose(capability, payload, transcript);
    return answer;
  }

  @override
  Future<EngineResponse> bankAccounts() async => EngineResponse(200, <String, Object?>{
        'status': 'ok',
        'result': <String, Object?>{
          'accounts': [
            <String, Object?>{'id': 1, 'code': '1000', 'name': 'Bank', 'isDefault': true, 'balanceMinor': 0},
            if (twoAccounts) <String, Object?>{'id': 9, 'code': '1020', 'name': 'Savings', 'isDefault': false, 'balanceMinor': 0},
          ],
        },
      });

  @override
  Future<EngineResponse> credits() async => EngineResponse(200, <String, Object?>{
        'status': 'ok',
        'result': <String, Object?>{'credits': <Object?>[], 'payments': payments, 'count': payments.length, 'truncated': false, 'derivedBy': 'credits.creditAvailable'},
      });
}

const _held = EngineResponse(200, <String, Object?>{'status': 'held', 'actionId': 7, 'message': 'Waiting for approval.'});

Future<void> _open(WidgetTester tester, EngineApi api) async {
  await tester.pumpWidget(MaterialApp(home: Scaffold(body: RefundForm(key: UniqueKey(), api: api, onClose: () {}, clock: () => DateTime(2026, 11, 17)))));
  await tester.pump();
  await tester.pump();
}

Future<void> _choose(WidgetTester tester, String text) async {
  await tester.tap(find.byKey(const Key('refund-form-payment')));
  await tester.pumpAndSettle();
  await tester.tap(find.textContaining(text).last);
  await tester.pumpAndSettle();
}

Future<void> _send(WidgetTester tester) async {
  await tester.ensureVisible(find.byKey(const Key('refund-form-send')));
  await tester.tap(find.byKey(const Key('refund-form-send')));
  await tester.pump();
  await tester.pump();
}

void main() {
  final fixtures = engineResponsesFrom(engineFixtureJson);

  test('the parser keeps only payments with money left and every figure, and says null when unreadable', () {
    final ok = parseOverpayments(200, <String, Object?>{
      'status': 'ok',
      'result': <String, Object?>{
        'payments': [
          <String, Object?>{'id': 5, 'partyName': 'Mokoena', 'currency': 'ZAR', 'receivedOn': '2026-11-01', 'availableMinor': 25050},
          <String, Object?>{'id': 6, 'partyName': 'X', 'currency': 'ZAR', 'receivedOn': '2026-11-01', 'availableMinor': 0},
          <String, Object?>{'id': 7, 'partyName': 'Y', 'currency': 'ZAR', 'availableMinor': 100},
        ],
      },
    })!;
    expect(ok.length, 1);
    expect(ok.first.availableMinor, 25050);
    expect(parseOverpayments(500, null), isNull);
    expect(parseOverpayments(200, <String, Object?>{'status': 'ok', 'result': <String, Object?>{}}), isNull);
  });

  test('a held refund reads as plain lines', () {
    const h = HeldAction(id: 9, type: 'engine.payment.refund', transcript: 'Added from the Refund an overpayment form', payload: <String, Object?>{'paymentId': 5, 'amountMinor': 25050, 'currency': 'ZAR', 'refundedOn': '2026-11-17', 'method': 'eft'});
    final lines = heldLines(h);
    expect(lines.map((l) => '${l.label}: ${l.value}').toList(), <String>['Payment: Payment #5', 'Refund: R250.50', 'Date: 2026-11-17', 'Paid back by: eft']);
  });

  testWidgets('lists the payments with what is left; choosing one fills the whole amount; sends the exact payload to be held', (tester) async {
    final api = _RApi(fixtures, _held);
    await _open(tester, api);
    await _choose(tester, 'Mokoena');
    expect(find.text('250.50'), findsOneWidget);
    await _send(tester);
    expect(api.proposed.length, 1);
    expect(api.proposed.first['capability'], 'payment.refund');
    expect(api.proposed.first['payload'], <String, Object?>{'paymentId': 5, 'amountMinor': 25050, 'refundedOn': '2026-11-17', 'method': 'eft'});
    expect(find.byKey(const Key('refund-form-sent')), findsOneWidget);
  });

  testWidgets('a part refund sends the typed amount', (tester) async {
    final api = _RApi(fixtures, _held);
    await _open(tester, api);
    await _choose(tester, 'Dlamini');
    await tester.enterText(find.byKey(const Key('refund-form-amount')), '40');
    await _send(tester);
    expect((api.proposed.first['payload'] as Map)['paymentId'], 6);
    expect((api.proposed.first['payload'] as Map)['amountMinor'], 4000);
  });

  testWidgets('with two bank accounts it asks which one the money is paid back from; with one it does not; cash never names one', (tester) async {
    final one = _RApi(fixtures, _held);
    await _open(tester, one);
    expect(find.byKey(const Key('refund-form-account')), findsNothing);
    final two = _RApi(fixtures, _held, twoAccounts: true);
    await _open(tester, two);
    await _choose(tester, 'Mokoena');
    await tester.ensureVisible(find.byKey(const Key('refund-form-account')));
    await tester.tap(find.byKey(const Key('refund-form-account')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Savings').last);
    await tester.pumpAndSettle();
    await _send(tester);
    expect(two.proposed.first['payload'], <String, Object?>{'paymentId': 5, 'amountMinor': 25050, 'refundedOn': '2026-11-17', 'method': 'eft', 'bankAccountId': 9});
  });

  testWidgets('no choice, an unclear amount or more than is left is not sent', (tester) async {
    final api = _RApi(fixtures, _held);
    await _open(tester, api);
    await _send(tester);
    expect(find.text('Choose the payment to refund first.'), findsOneWidget);
    await _choose(tester, 'Dlamini');
    await tester.enterText(find.byKey(const Key('refund-form-amount')), '12.345');
    await _send(tester);
    expect(find.text('Type the amount in rand, for example 450.00.'), findsOneWidget);
    await tester.enterText(find.byKey(const Key('refund-form-amount')), '100.01');
    await _send(tester);
    expect(find.textContaining('is left to refund.'), findsOneWidget);
    expect(api.proposed, isEmpty);
  });

  testWidgets("shows the engine's reason when it refuses", (tester) async {
    final api = _RApi(fixtures, const EngineResponse(409, <String, Object?>{'error': 'invalid_state', 'message': 'Only 10000 of that payment is left to refund.'}));
    await _open(tester, api);
    await _choose(tester, 'Dlamini');
    await _send(tester);
    expect(find.text('Only 10000 of that payment is left to refund.'), findsOneWidget);
    expect(find.byKey(const Key('refund-form-sent')), findsNothing);
  });

  testWidgets('with nothing to refund it says so', (tester) async {
    final api = _RApi(fixtures, _held, payments: const <Object?>[]);
    await _open(tester, api);
    expect(find.byKey(const Key('refund-form-none')), findsOneWidget);
  });

  testWidgets('the refund button in the invoices room opens the form', (tester) async {
    final api = _RApi(fixtures, _held);
    await tester.pumpWidget(MaterialApp(home: Scaffold(body: InvoicesRoom(key: UniqueKey(), api: api))));
    await tester.pump(const Duration(milliseconds: 100));
    await tester.tap(find.byKey(const Key('invoices-refund')));
    await tester.pump();
    await tester.pump();
    expect(find.byKey(const Key('refund-form-payment')), findsOneWidget);
  });
}
