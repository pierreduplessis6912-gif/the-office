// The change customer or supplier form (lib/engine/party_edit_form.dart). Pinned: it starts from what the engine lists; sends only what CHANGED as party.edit to be HELD (a detail emptied is cleared with null);
// refuses an empty name, a change of nothing and a payment term that is not whole days, without sending; shows the engine's own reason when it refuses; the customer's details open it from the parties room
// and closing reads the list again; the approval lines read a party change (and a new customer's payment term) in words. Recorded client, no network.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:the_office/engine/assistant_model.dart';
import 'package:the_office/engine/engine_api.dart';
import 'package:the_office/engine/engine_fixtures.dart';
import 'package:the_office/engine/parties_room.dart';
import 'package:the_office/engine/party_edit_form.dart';

class _EApi extends FixtureEngineApi {
  final EngineResponse answer;
  int reads = 0;
  _EApi(Map<String, EngineResponse> fixtures, this.answer) : super(fixtures);
  @override
  Future<EngineResponse> propose(String capability, Map<String, Object?> payload, String transcript) async {
    await super.propose(capability, payload, transcript);
    return answer;
  }

  @override
  Future<EngineResponse> parties({String? role}) async {
    reads++;
    return EngineResponse(200, <String, Object?>{
      'status': 'ok',
      'result': <String, Object?>{
        'parties': <Object?>[
          <String, Object?>{'id': 3, 'name': 'Mokoena', 'kind': 'person', 'roles': ['customer'], 'contact': <String, Object?>{'phone': '082 555 0101', 'email': 'm@x.co.za', 'paymentTermsDays': '30'}},
        ],
        'count': 1,
      },
    });
  }

  @override
  Future<EngineResponse> receivables(String party) async => const EngineResponse(500, null);
}

const _held = EngineResponse(200, <String, Object?>{'status': 'held', 'actionId': 9, 'message': 'Waiting for approval.'});
const _mokoena = PartyEntry(id: 3, name: 'Mokoena', roles: <String>['customer'], email: 'm@x.co.za', phone: '082 555 0101', paymentTermsDays: '30');
const _supplier = PartyEntry(id: 4, name: 'Timber Supplies', roles: <String>['supplier'], email: '', phone: '');

Future<void> _form(WidgetTester tester, EngineApi api, PartyEntry p, {VoidCallback? onClose}) async {
  await tester.pumpWidget(MaterialApp(home: Scaffold(body: PartyEditForm(key: UniqueKey(), api: api, party: p, onClose: onClose ?? () {}))));
  await tester.pump();
}

Future<void> _enter(WidgetTester tester, String key, String text) async {
  await tester.ensureVisible(find.byKey(Key(key)));
  await tester.enterText(find.byKey(Key(key)), text);
}

Future<void> _send(WidgetTester tester) async {
  await tester.ensureVisible(find.byKey(const Key('party-edit-send')));
  await tester.tap(find.byKey(const Key('party-edit-send')));
  await tester.pump();
  await tester.pump();
}

void main() {
  final fixtures = engineResponsesFrom(engineFixtureJson);

  testWidgets('starts from the listed details and sends only what changed, to be held', (tester) async {
    final api = _EApi(fixtures, _held);
    await _form(tester, api, _mokoena);
    expect(tester.widget<TextField>(find.byKey(const Key('party-edit-name'))).controller!.text, 'Mokoena');
    expect(tester.widget<TextField>(find.byKey(const Key('party-edit-terms'))).controller!.text, '30');
    await _enter(tester, 'party-edit-terms', '14');
    await _send(tester);
    expect(api.proposed.length, 1);
    expect(api.proposed.first['capability'], 'party.edit');
    expect(api.proposed.first['payload'], <String, Object?>{'partyId': 3, 'contact': <String, Object?>{'paymentTermsDays': '14'}});
    expect(find.byKey(const Key('party-edit-sent')), findsOneWidget);
  });

  testWidgets('a new name is sent as the name; an emptied detail is cleared with null', (tester) async {
    final api = _EApi(fixtures, _held);
    await _form(tester, api, _mokoena);
    await _enter(tester, 'party-edit-name', '  Mokoena Flooring ');
    await _enter(tester, 'party-edit-phone', '');
    await _enter(tester, 'party-edit-terms', '');
    await _send(tester);
    expect(api.proposed.first['payload'], <String, Object?>{
      'partyId': 3,
      'name': 'Mokoena Flooring',
      'contact': <String, Object?>{'phone': null, 'paymentTermsDays': null},
    });
  });

  testWidgets('nothing changed, an empty name and a term that is not whole days are not sent', (tester) async {
    final api = _EApi(fixtures, _held);
    await _form(tester, api, _mokoena);
    await _send(tester);
    expect(find.text('Nothing is changed.'), findsOneWidget);
    await _enter(tester, 'party-edit-name', '   ');
    await _send(tester);
    expect(find.text('The name cannot be empty.'), findsOneWidget);
    await _enter(tester, 'party-edit-name', 'Mokoena');
    await _enter(tester, 'party-edit-terms', '30.5');
    await _send(tester);
    expect(find.textContaining('whole number of days'), findsOneWidget);
    await _enter(tester, 'party-edit-terms', '400');
    await _send(tester);
    expect(find.textContaining('at most 365'), findsOneWidget);
    expect(api.proposed, isEmpty);
  });

  testWidgets('a supplier has no payment term field', (tester) async {
    await _form(tester, _EApi(fixtures, _held), _supplier);
    expect(find.byKey(const Key('party-edit-terms')), findsNothing);
  });

  testWidgets("the engine's own reason is shown on a refusal and nothing is marked sent", (tester) async {
    final api = _EApi(fixtures, const EngineResponse(422, <String, Object?>{'status': 'error', 'message': 'email must look like name@example.com'}));
    await _form(tester, api, _mokoena);
    await _enter(tester, 'party-edit-email', 'nonsense');
    await _send(tester);
    expect(find.textContaining('must look like'), findsOneWidget);
    expect(find.byKey(const Key('party-edit-sent')), findsNothing);
  });

  testWidgets('Cancel closes the form', (tester) async {
    var closed = 0;
    await _form(tester, _EApi(fixtures, _held), _mokoena, onClose: () => closed++);
    await tester.ensureVisible(find.byKey(const Key('party-edit-cancel')));
    await tester.tap(find.byKey(const Key('party-edit-cancel')));
    expect(closed, 1);
  });

  testWidgets('the customer details open the form, show the term, and closing reads the list again', (tester) async {
    final api = _EApi(fixtures, _held);
    await tester.pumpWidget(MaterialApp(home: Scaffold(body: PartiesRoom(key: UniqueKey(), api: api))));
    await tester.pump(const Duration(milliseconds: 100));
    await tester.pump(const Duration(milliseconds: 100));
    await tester.tap(find.byKey(const Key('party-row-3')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 100));
    expect(find.text('Payment term: 30 days'), findsOneWidget);
    await tester.tap(find.byKey(const Key('party-edit')));
    await tester.pump();
    expect(find.byKey(const Key('party-edit-send')), findsOneWidget);
    final before = api.reads;
    await tester.ensureVisible(find.byKey(const Key('party-edit-cancel')));
    await tester.tap(find.byKey(const Key('party-edit-cancel')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 100));
    expect(api.reads, before + 1);
  });

  test('approval lines read a party change and a new customer\'s payment term in words', () {
    HeldAction held(String type, Map<String, Object?> payload) => HeldAction(id: 1, type: type, payload: payload, transcript: '');
    expect(heldTitle('engine.party.edit'), 'Change a customer or supplier');
    final edit = heldLines(held('engine.party.edit', <String, Object?>{'partyId': 3, 'name': 'Mokoena Flooring', 'contact': <String, Object?>{'phone': null, 'paymentTermsDays': '14'}}), names: <int, String>{3: 'Mokoena'});
    expect(edit.map((l) => '${l.label}: ${l.value}').toList(), <String>['Customer or supplier: Mokoena', 'New name: Mokoena Flooring', 'Phone: Cleared', 'Payment term: 14 days']);
    final create = heldLines(held('engine.party.create', <String, Object?>{'kind': 'person', 'name': 'Sipho', 'roles': ['customer'], 'contact': <String, Object?>{'paymentTermsDays': '30'}}));
    expect(create.map((l) => '${l.label}: ${l.value}').toList(), contains('Payment term: 30 days'));
  });
}
