// The jobs room (lib/engine/jobs_room.dart) and the make-a-job form (lib/engine/job_form.dart). Pinned: the room groups the engine's rows (overdue by the engine's flag, this week, later, no date yet) and
// moves nothing; a read that cannot be understood says so; the form lists only customers (and installers for the optional person), sends exactly the job.create payload to be HELD, refuses an empty
// customer, an empty piece of work and a date that is not a date without sending, and shows the engine's own reason on a refusal; the approval lines read a job in words. Recorded client, no network.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:the_office/engine/assistant_model.dart';
import 'package:the_office/engine/engine_api.dart';
import 'package:the_office/engine/engine_fixtures.dart';
import 'package:the_office/engine/job_form.dart';
import 'package:the_office/engine/jobs_room.dart';

EngineResponse _ok(Map<String, Object?> result) => EngineResponse(200, <String, Object?>{'status': 'ok', 'result': result});

class _JApi extends FixtureEngineApi {
  final EngineResponse answer;
  final EngineResponse jobsAnswer;
  _JApi(Map<String, EngineResponse> fixtures, this.answer, this.jobsAnswer) : super(fixtures);

  @override
  Future<EngineResponse> jobs() async => jobsAnswer;

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
          <String, Object?>{'id': 5, 'name': 'Sipho', 'kind': 'person', 'roles': ['installer']},
        ],
        'count': 3,
      });
}

const _held = EngineResponse(200, <String, Object?>{'status': 'held', 'actionId': 7, 'message': 'Waiting for approval.'});
Map<String, Object?> _job(int id, String what, {String? on, bool overdue = false, String? who, String? site, Map<String, Object?>? money, List<Object?>? snags}) => <String, Object?>{
      'id': id, 'partyId': 3, 'partyName': 'Mokoena', 'description': what, 'siteAddress': site, 'reference': null, 'scheduledOn': on, 'assigneeId': null, 'assigneeName': who, 'status': 'open', 'overdue': overdue, 'snags': snags ?? <Object?>[], 'openSnags': (snags ?? <Object?>[]).where((s) => s is Map && s['open'] == true).length, 'money': money ?? <String, Object?>{'quotedMinor': 0, 'invoicedMinor': 0, 'paidMinor': 0, 'spentMinor': 0, 'leftOverMinor': 0, 'linked': 0},
    };
final _jobs = _ok(<String, Object?>{
  'jobs': [
    _job(2, 'Bedroom blinds', on: '2026-11-12', overdue: true),
    _job(1, 'Lounge floor', on: '2026-11-20', who: 'Sipho', site: '12 Palm Rd', money: <String, Object?>{'quotedMinor': 115000, 'invoicedMinor': 115000, 'paidMinor': 50000, 'spentMinor': 23000, 'leftOverMinor': 27000, 'linked': 3}, snags: [<String, Object?>{'id': 31, 'note': 'Scratch near the door', 'open': true}, <String, Object?>{'id': 32, 'note': 'Fixed already', 'open': false}]),
    _job(4, 'Patio', on: '2026-12-10'),
    _job(3, 'Quote visit'),
    <String, Object?>{'partyName': 'x'},
  ],
  'count': 4,
});

Future<void> _room(WidgetTester tester, EngineApi api) async {
  await tester.pumpWidget(MaterialApp(home: Scaffold(body: JobsRoom(key: UniqueKey(), api: api, clock: () => DateTime(2026, 11, 17)))));
  await tester.pump();
  await tester.pump();
}

Future<void> _form(WidgetTester tester, EngineApi api) async {
  await tester.pumpWidget(MaterialApp(home: Scaffold(body: JobForm(key: UniqueKey(), api: api, onClose: () {}))));
  await tester.pump();
  await tester.pump();
}

Future<void> _pickCustomer(WidgetTester tester) async {
  await tester.tap(find.byKey(const Key('job-form-customer')));
  await tester.pumpAndSettle();
  await tester.tap(find.text('Mokoena').last);
  await tester.pumpAndSettle();
}

Future<void> _send(WidgetTester tester) async {
  await tester.ensureVisible(find.byKey(const Key('job-form-send')));
  await tester.tap(find.byKey(const Key('job-form-send')));
  await tester.pump();
  await tester.pump();
}

void main() {
  final fixtures = engineResponsesFrom(engineFixtureJson);

  testWidgets('the room groups the rows and a row without a description is left out', (tester) async {
    await _room(tester, _JApi(fixtures, _held, _jobs));
    expect(find.byKey(const Key('jobs-group-overdue')), findsOneWidget);
    expect(find.byKey(const Key('jobs-group-week')), findsOneWidget);
    expect(find.byKey(const Key('jobs-group-later')), findsOneWidget);
    expect(find.byKey(const Key('jobs-group-undated')), findsOneWidget);
    for (final id in [1, 2, 3, 4]) {
      expect(find.byKey(Key('job-row-$id')), findsOneWidget);
    }
    expect(find.text('Mokoena · Lounge floor'), findsOneWidget);
    expect(find.text('With Sipho'), findsOneWidget);
    expect(find.text('12 Palm Rd'), findsOneWidget);
    expect(find.byKey(const Key('job-money-1')), findsOneWidget);
    expect(find.text('Quoted R1,150.00 · Invoiced R1,150.00 · Paid R500.00 · Spent R230.00 · Left over R270.00'), findsOneWidget);
    expect(find.byKey(const Key('job-money-2')), findsNothing);
    expect(find.text('Snag: Scratch near the door'), findsOneWidget);
    expect(find.textContaining('Fixed already'), findsNothing);
    expect(find.text('Overdue'), findsWidgets);
    expect(find.text('No date yet'), findsWidgets);
  });

  testWidgets('an empty list and an unreadable answer say so', (tester) async {
    await _room(tester, _JApi(fixtures, _held, _ok(<String, Object?>{'jobs': <Object?>[], 'count': 0})));
    expect(find.byKey(const Key('jobs-empty')), findsOneWidget);
    await _room(tester, _JApi(fixtures, _held, const EngineResponse(500, <String, Object?>{})));
    expect(find.byKey(const Key('jobs-error')), findsOneWidget);
  });

  testWidgets('the plus opens the form', (tester) async {
    await _room(tester, _JApi(fixtures, _held, _jobs));
    await tester.tap(find.byKey(const Key('jobs-add')));
    await tester.pump();
    await tester.pump();
    expect(find.byKey(const Key('job-form-send')), findsOneWidget);
  });

  testWidgets('the form lists only customers and installers and sends the exact payload to be held', (tester) async {
    final api = _JApi(fixtures, _held, _jobs);
    await _form(tester, api);
    await tester.tap(find.byKey(const Key('job-form-customer')));
    await tester.pumpAndSettle();
    expect(find.text('Timber Supplies'), findsNothing);
    await tester.tap(find.text('Mokoena').last);
    await tester.pumpAndSettle();
    await tester.enterText(find.byKey(const Key('job-form-what')), ' Lounge floor ');
    await tester.enterText(find.byKey(const Key('job-form-site')), '12 Palm Rd');
    await tester.enterText(find.byKey(const Key('job-form-date')), '2026-11-20');
    await tester.enterText(find.byKey(const Key('job-form-reference')), 'PO-7');
    await tester.ensureVisible(find.byKey(const Key('job-form-installer')));
    await tester.tap(find.byKey(const Key('job-form-installer')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Sipho').last);
    await tester.pumpAndSettle();
    await _send(tester);
    expect(api.proposed.length, 1);
    expect(api.proposed.first['capability'], 'job.create');
    expect(api.proposed.first['payload'], <String, Object?>{'partyId': 3, 'description': 'Lounge floor', 'siteAddress': '12 Palm Rd', 'scheduledOn': '2026-11-20', 'assigneeId': 5, 'reference': 'PO-7'});
    expect(find.byKey(const Key('job-form-sent')), findsOneWidget);
  });

  testWidgets('only the customer and the work are needed, and the rest is left out of the payload', (tester) async {
    final api = _JApi(fixtures, _held, _jobs);
    await _form(tester, api);
    await _pickCustomer(tester);
    await tester.enterText(find.byKey(const Key('job-form-what')), 'Patio');
    await _send(tester);
    expect(api.proposed.first['payload'], <String, Object?>{'partyId': 3, 'description': 'Patio'});
  });

  testWidgets('no customer, no work or a bad date is not sent', (tester) async {
    final api = _JApi(fixtures, _held, _jobs);
    await _form(tester, api);
    await _send(tester);
    expect(find.byKey(const Key('job-form-problem')), findsOneWidget);
    await _pickCustomer(tester);
    await _send(tester);
    expect(find.text('Say what the work is.'), findsOneWidget);
    await tester.enterText(find.byKey(const Key('job-form-what')), 'Patio');
    await tester.enterText(find.byKey(const Key('job-form-date')), '20/11/2026');
    await _send(tester);
    expect(find.textContaining('must look like'), findsOneWidget);
    expect(api.proposed, isEmpty);
  });

  testWidgets("the engine's own reason is shown on a refusal and nothing is marked sent", (tester) async {
    final api = _JApi(fixtures, const EngineResponse(409, <String, Object?>{'status': 'error', 'message': 'There is already an open job like that for Mokoena (job 1). Nothing was added.'}), _jobs);
    await _form(tester, api);
    await _pickCustomer(tester);
    await tester.enterText(find.byKey(const Key('job-form-what')), 'Lounge floor');
    await _send(tester);
    expect(find.textContaining('already an open job'), findsOneWidget);
    expect(find.byKey(const Key('job-form-sent')), findsNothing);
  });

  test('approval lines read a job in words', () {
    HeldAction held(String type, Map<String, Object?> payload) => HeldAction(id: 1, type: type, payload: payload, transcript: '');
    expect(heldTitle('engine.job.create'), 'Make a job');
    expect(heldTitle('engine.job.schedule'), 'Schedule a job');
    expect(heldTitle('engine.job.assign'), 'Put someone on a job');
    expect(heldTitle('engine.job.cancel'), 'Cancel a job');
    expect(heldTitle('engine.job.complete'), 'Mark a job done');
    expect(heldTitle('engine.job.snag_raise'), 'Note a snag');
    expect(heldTitle('engine.job.snag_close'), 'Close a snag');
    expect(heldLines(held('engine.job.snag_raise', <String, Object?>{'jobId': 2, 'note': 'Scratch'})).map((l) => l.value).toList(), ['Job #2', 'Scratch']);
    expect(heldLines(held('engine.job.snag_close', <String, Object?>{'jobId': 2, 'snagId': 31})).map((l) => l.value).toList(), ['Job #2', 'Snag #31']);
    expect(heldTitle('engine.job.link'), 'Tie money to a job');
    expect(heldLines(held('engine.job.link', <String, Object?>{'jobId': 2, 'documentId': 9})).map((l) => l.value).toList(), ['Job #2', 'Document #9']);
    final made = heldLines(held('engine.job.create', <String, Object?>{'partyId': 3, 'description': 'Lounge floor', 'siteAddress': '12 Palm Rd', 'scheduledOn': '2026-11-20', 'assigneeId': 5}), names: <int, String>{3: 'Mokoena', 5: 'Sipho'});
    expect(made.map((l) => '${l.label}: ${l.value}').toList(), ['Customer: Mokoena', 'Work: Lounge floor', 'Site: 12 Palm Rd', 'On: 2026-11-20', 'Person: Sipho']);
    expect(heldLines(held('engine.job.schedule', <String, Object?>{'jobId': 2, 'scheduledOn': null})).map((l) => l.value).toList(), ['Job #2', 'No date (off the calendar)']);
    expect(heldLines(held('engine.job.assign', <String, Object?>{'jobId': 2, 'assigneeId': null})).map((l) => l.value).toList(), ['Job #2', 'Nobody (taken off)']);
    expect(heldLines(held('engine.job.cancel', <String, Object?>{'jobId': 2, 'reason': 'Changed her mind'})).map((l) => l.value).toList(), ['Job #2', 'Changed her mind']);
  });
}
