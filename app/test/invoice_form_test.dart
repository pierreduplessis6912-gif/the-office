// The make-a-quotation form (lib/engine/invoice_form.dart) and its line editor. Pinned: it sends exactly the payload the assistant would (invoice.issue: customer, dates, ZAR, optional reference, lines with
// whole-thousandth quantity, unit, price in cents and VAT as 15% or 0) to be HELD; lines can be added and removed; a missing customer or an unclear line is not sent and names which line; the engine's own reason
// is shown on a refusal; the "+" in the quotes room opens it. Recorded client, no network.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:the_office/engine/engine_api.dart';
import 'package:the_office/engine/engine_fixtures.dart';
import 'package:the_office/engine/invoices_room.dart';
import 'package:the_office/engine/invoice_form.dart';

EngineResponse _ok(Map<String, Object?> result) => EngineResponse(200, <String, Object?>{'status': 'ok', 'result': result});


class _IApi extends FixtureEngineApi {
  final EngineResponse answer;
  _IApi(Map<String, EngineResponse> fixtures, this.answer) : super(fixtures);

  @override
  Future<EngineResponse> propose(String capability, Map<String, Object?> payload, String transcript) async {
    await super.propose(capability, payload, transcript);
    return answer;
  }

  @override
  Future<EngineResponse> parties({String? role}) async => EngineResponse(200, <String, Object?>{
        'status': 'ok',
        'result': <String, Object?>{
          'parties': [
            <String, Object?>{'id': 3, 'name': 'Mokoena', 'kind': 'person', 'roles': ['customer']},
            <String, Object?>{'id': 4, 'name': 'Timber Supplies', 'kind': 'organisation', 'roles': ['supplier']},
          ],
          'count': 2,
        },
      });
}

class _NotReadyApi extends _IApi {
  _NotReadyApi(Map<String, EngineResponse> fixtures) : super(fixtures, _held);

  @override
  Future<EngineResponse> saveDraft(int draftId, int expectedVersion, int partyId, Map<String, Object?> payload) async => const EngineResponse(200, <String, Object?>{
        'version': 2,
        'validation': <String, Object?>{
          'ok': false,
          'errors': [
            <String, Object?>{'field': 'issuedOn', 'message': 'an issue date is needed'},
          ],
          'totals': null,
        },
      });
}

const _held = EngineResponse(200, <String, Object?>{'status': 'held', 'actionId': 7, 'message': 'Waiting for approval.'});

Future<void> _open(WidgetTester tester, EngineApi api) async {
  await tester.pumpWidget(MaterialApp(home: Scaffold(body: InvoiceForm(key: UniqueKey(), api: api, onClose: () {}, clock: () => DateTime(2026, 11, 17)))));
  await tester.pump();
  await tester.pump();
}

Future<void> _chooseCustomer(WidgetTester tester) async {
  await tester.tap(find.byKey(const Key('invoice-form-customer')));
  await tester.pumpAndSettle();
  await tester.tap(find.text('Mokoena').last);
  await tester.pumpAndSettle();
}

Future<void> _send(WidgetTester tester) async {
  await tester.ensureVisible(find.byKey(const Key('invoice-form-send')));
  await tester.tap(find.byKey(const Key('invoice-form-send')));
  await tester.pump();
  await tester.pump();
}

Future<void> _fill(WidgetTester tester, int i, {String what = 'Vinyl plank', String qty = '2.5', String unit = 'm²', String price = '450'}) async {
  for (final e in {'description': what, 'quantity': qty, 'unit': unit, 'price': price}.entries) {
    await tester.ensureVisible(find.byKey(Key('invoice-form-line-$i-${e.key}')));
    await tester.enterText(find.byKey(Key('invoice-form-line-$i-${e.key}')), e.value);
  }
}

void main() {
  final fixtures = engineResponsesFrom(engineFixtureJson);

  testWidgets('lists only customers and sends the exact payload to be held', (tester) async {
    final api = _IApi(fixtures, _held);
    await _open(tester, api);
    await tester.tap(find.byKey(const Key('invoice-form-customer')));
    await tester.pumpAndSettle();
    expect(find.text('Timber Supplies'), findsNothing);
    await tester.tap(find.text('Mokoena').last);
    await tester.pumpAndSettle();
    await tester.enterText(find.byKey(const Key('invoice-form-reference')), 'Lounge floor');
    await _fill(tester, 0);
    await _send(tester);
    expect(api.drafted, <Map<String, Object?>>[
      <String, Object?>{'create': 3},
      <String, Object?>{
        'save': 1,
        'expectedVersion': 1,
        'partyId': 3,
        'payload': <String, Object?>{
          'currency': 'ZAR',
          'issuedOn': '2026-11-17',
          'reference': 'Lounge floor',
          'lines': [
            <String, Object?>{'description': 'Vinyl plank', 'quantityMilli': 2500, 'unit': 'm²', 'unitPriceMinor': 45000, 'taxBp': 1500},
          ],
        },
      },
    ]);
    expect(api.proposed.length, 1);
    expect(api.proposed.first['capability'], 'invoice.issue');
    expect(api.proposed.first['payload'], <String, Object?>{'draftId': 1, 'expectedVersion': 2});
    expect(find.byKey(const Key('invoice-form-sent')), findsOneWidget);
  });

  testWidgets('lines can be added and removed; a line without VAT sends rate 0 and a blank unit sends null', (tester) async {
    final api = _IApi(fixtures, _held);
    await _open(tester, api);
    await _chooseCustomer(tester);
    await tester.ensureVisible(find.byKey(const Key('invoice-form-add-line')));
    await tester.tap(find.byKey(const Key('invoice-form-add-line')));
    await tester.pump();
    expect(find.byKey(const Key('invoice-form-line-1')), findsOneWidget);
    await _fill(tester, 0, what: 'Fitting', qty: '1', unit: '', price: '800');
    await tester.ensureVisible(find.byKey(const Key('invoice-form-line-0-vat')));
    await tester.tap(find.byKey(const Key('invoice-form-line-0-vat')));
    await tester.pump();
    await tester.ensureVisible(find.byKey(const Key('invoice-form-line-1-remove')));
    await tester.tap(find.byKey(const Key('invoice-form-line-1-remove')));
    await tester.pump();
    expect(find.byKey(const Key('invoice-form-line-1')), findsNothing);
    expect(find.byKey(const Key('invoice-form-line-0-remove')), findsNothing);
    await _send(tester);
    final line = (((api.drafted.last['payload']) as Map)['lines'] as List).single as Map;
    expect(line, <String, Object?>{'description': 'Fitting', 'quantityMilli': 1000, 'unit': null, 'unitPriceMinor': 80000, 'taxBp': 0});
  });

  testWidgets('no customer or an unclear line is not sent and says which line', (tester) async {
    final api = _IApi(fixtures, _held);
    await _open(tester, api);
    await _send(tester);
    expect(find.text('Choose the customer first.'), findsOneWidget);
    await _chooseCustomer(tester);
    await _send(tester);
    expect(find.text('Line 1 needs a description.'), findsOneWidget);
    await _fill(tester, 0, qty: '0');
    await _send(tester);
    expect(find.text('Line 1: type the quantity as a number, for example 2 or 2.5.'), findsOneWidget);
    await _fill(tester, 0, qty: '1', price: '12.345');
    await _send(tester);
    expect(find.text('Line 1: type the price in rand, for example 450.00.'), findsOneWidget);
    expect(api.proposed, isEmpty);
    expect(api.drafted, isEmpty);
  });

  testWidgets("shows the engine's reason when it refuses", (tester) async {
    final api = _IApi(fixtures, const EngineResponse(422, <String, Object?>{'error': 'invalid_state', 'message': 'There is a tax lock on that date.'}));
    await _open(tester, api);
    await _chooseCustomer(tester);
    await _fill(tester, 0);
    await _send(tester);
    expect(find.text('There is a tax lock on that date.'), findsOneWidget);
    expect(find.byKey(const Key('invoice-form-sent')), findsNothing);
  });

  testWidgets('when the engine says the draft is not ready, its first reason is shown and nothing is proposed', (tester) async {
    final api = _NotReadyApi(fixtures);
    await _open(tester, api);
    await _chooseCustomer(tester);
    await _fill(tester, 0);
    await _send(tester);
    expect(find.text('an issue date is needed'), findsOneWidget);
    expect(api.proposed, isEmpty);
  });

  testWidgets('the invoice button in the invoices room opens the form', (tester) async {
    final api = _IApi(fixtures, _held);
    await tester.pumpWidget(MaterialApp(home: Scaffold(body: InvoicesRoom(key: UniqueKey(), api: api))));
    await tester.pump(const Duration(milliseconds: 100));
    await tester.tap(find.byKey(const Key('invoices-add')));
    await tester.pump();
    await tester.pump();
    expect(find.byKey(const Key('invoice-form-customer')), findsOneWidget);
  });
}
