// The new customer or supplier form (lib/engine/party_form.dart). Pinned: the form sends exactly the payload the assistant would (party.create: kind, name, roles, optional contact) to be HELD, says it is
// waiting for approval and writes nothing itself; an empty name or no role is not sent; the engine's own reason is shown when it refuses and what was typed is kept; the "+" in the parties room opens it
// and closing it reads the list again. Recorded client, no network.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:the_office/engine/engine_api.dart';
import 'package:the_office/engine/engine_fixtures.dart';
import 'package:the_office/engine/parties_room.dart';
import 'package:the_office/engine/party_form.dart';

class _FormApi extends FixtureEngineApi {
  final EngineResponse answer;
  int partiesReads = 0;
  _FormApi(Map<String, EngineResponse> fixtures, this.answer) : super(fixtures);
  @override
  Future<EngineResponse> propose(String capability, Map<String, Object?> payload, String transcript) async {
    await super.propose(capability, payload, transcript);
    return answer;
  }

  @override
  Future<EngineResponse> parties({String? role}) async {
    partiesReads++;
    return EngineResponse(200, <String, Object?>{'status': 'ok', 'result': <String, Object?>{'parties': <Object?>[], 'count': 0}});
  }
}

const _held = EngineResponse(200, <String, Object?>{'status': 'held', 'actionId': 7, 'message': 'Waiting for approval.'});

Future<void> _openForm(WidgetTester tester, EngineApi api, {VoidCallback? onClose}) async {
  await tester.pumpWidget(MaterialApp(home: Scaffold(body: PartyForm(key: UniqueKey(), api: api, onClose: onClose ?? () {}))));
  await tester.pump();
}

void main() {
  final fixtures = engineResponsesFrom(engineFixtureJson);

  testWidgets('sends the exact payload to be held and says it is waiting for approval', (tester) async {
    final api = _FormApi(fixtures, _held);
    await _openForm(tester, api);
    await tester.enterText(find.byKey(const Key('party-form-name')), '  Mokoena Flooring  ');
    await tester.tap(find.text('Business'));
    await tester.tap(find.byKey(const Key('party-form-supplier')));
    await tester.enterText(find.byKey(const Key('party-form-phone')), '082 555 0101');
    await tester.enterText(find.byKey(const Key('party-form-email')), 'info@mokoena.example');
    await tester.pump();
    await tester.tap(find.byKey(const Key('party-form-send')));
    await tester.pump();
    await tester.pump();
    expect(api.proposed.length, 1);
    expect(api.proposed.first['capability'], 'party.create');
    expect(api.proposed.first['payload'], <String, Object?>{
      'kind': 'organisation',
      'name': 'Mokoena Flooring',
      'roles': <String>['customer', 'supplier'],
      'contact': <String, Object?>{'phone': '082 555 0101', 'email': 'info@mokoena.example'},
    });
    expect(find.byKey(const Key('party-form-sent')), findsOneWidget);
  });

  testWidgets('a person with only a name is a customer and carries no contact', (tester) async {
    final api = _FormApi(fixtures, _held);
    await _openForm(tester, api);
    await tester.enterText(find.byKey(const Key('party-form-name')), 'Thandi');
    await tester.tap(find.byKey(const Key('party-form-send')));
    await tester.pump();
    await tester.pump();
    expect(api.proposed.first['payload'], <String, Object?>{'kind': 'person', 'name': 'Thandi', 'roles': <String>['customer']});
  });

  testWidgets('an empty name, or no role, is not sent', (tester) async {
    final api = _FormApi(fixtures, _held);
    await _openForm(tester, api);
    await tester.tap(find.byKey(const Key('party-form-send')));
    await tester.pump();
    expect(api.proposed, isEmpty);
    expect(find.byKey(const Key('party-form-problem')), findsOneWidget);
    await tester.enterText(find.byKey(const Key('party-form-name')), 'Thandi');
    await tester.tap(find.byKey(const Key('party-form-customer')));
    await tester.pump();
    await tester.tap(find.byKey(const Key('party-form-send')));
    await tester.pump();
    expect(api.proposed, isEmpty);
    expect(find.text('Choose customer, supplier or both.'), findsOneWidget);
  });

  testWidgets("shows the engine's reason when it refuses and keeps what was typed", (tester) async {
    final api = _FormApi(fixtures, const EngineResponse(409, <String, Object?>{'error': 'duplicate', 'message': 'There is already a customer or supplier called Thandi.'}));
    await _openForm(tester, api);
    await tester.enterText(find.byKey(const Key('party-form-name')), 'Thandi');
    await tester.tap(find.byKey(const Key('party-form-send')));
    await tester.pump();
    await tester.pump();
    expect(find.text('There is already a customer or supplier called Thandi.'), findsOneWidget);
    expect(find.byKey(const Key('party-form-sent')), findsNothing);
    expect(find.text('Thandi'), findsOneWidget);
  });

  testWidgets('says so when the answer cannot be read', (tester) async {
    final api = _FormApi(fixtures, const EngineResponse(500, null));
    await _openForm(tester, api);
    await tester.enterText(find.byKey(const Key('party-form-name')), 'Thandi');
    await tester.tap(find.byKey(const Key('party-form-send')));
    await tester.pump();
    await tester.pump();
    expect(find.byKey(const Key('party-form-problem')), findsOneWidget);
    expect(find.byKey(const Key('party-form-sent')), findsNothing);
  });

  testWidgets('the plus in the parties room opens the form, and closing it reads the list again', (tester) async {
    final api = _FormApi(fixtures, _held);
    await tester.pumpWidget(MaterialApp(home: Scaffold(body: PartiesRoom(key: UniqueKey(), api: api))));
    await tester.pump(const Duration(milliseconds: 100));
    final before = api.partiesReads;
    await tester.tap(find.byKey(const Key('parties-add')));
    await tester.pump();
    expect(find.byKey(const Key('party-form-name')), findsOneWidget);
    await tester.tap(find.byKey(const Key('party-form-cancel')));
    await tester.pump(const Duration(milliseconds: 100));
    expect(find.byKey(const Key('party-form-name')), findsNothing);
    expect(api.partiesReads, greaterThan(before));
  });
}
