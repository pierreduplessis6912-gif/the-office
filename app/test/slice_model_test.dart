// The Mokoena slice model (lib/slice_model.dart). What this pins: the readers understand the engine's REAL answers (the files in test/fixtures/slice, which tools/slice-mokoena.test.js keeps equal to what the backend answers);
// anything unusable is reported as such and nothing throws; lists are bounded; amounts are only formatted, never calculated; and the journey (question, answer, drill-down, back to the conversation, propose, approve)
// moves only where it makes sense, so a late or repeated answer cannot put the screen in the wrong place. It does not test layout: that needs a device.
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:the_office/slice_model.dart';

Map<String, Object?> _fx(String name) => jsonDecode(File('test/fixtures/slice/$name.json').readAsStringSync()) as Map<String, Object?>;
int _status(Map<String, Object?> fx) => fx['status'] as int;
Object? _body(Map<String, Object?> fx) => fx['body'];

SliceRead _read(String name) => parseReceivables(_status(_fx(name)), _body(_fx(name)));
SliceRecord? _record(String name) => parseRecord(_status(_fx(name)), _body(_fx(name)));
SliceProposal _proposal(String name) => parseProposal(_status(_fx(name)), _body(_fx(name)));
SliceConfirm _confirm(String name) => parseConfirm(_status(_fx(name)), _body(_fx(name)));

void main() {
  group('randFromMinor only formats', () {
    test('rands, cents, grouping and sign', () {
      expect(randFromMinor(115000), 'R1,150.00');
      expect(randFromMinor(138000), 'R1,380.00');
      expect(randFromMinor(0), 'R0.00');
      expect(randFromMinor(5), 'R0.05');
      expect(randFromMinor(100000000), 'R1,000,000.00');
      expect(randFromMinor(-2300), '-R23.00');
      expect(randFromMinor(100, currency: 'USD'), 'USD 1.00');
      expect(randFromMinor(100, currency: 'ZAR'), 'R1.00');
    });
  });

  group('the answer to "what does Mokoena owe?"', () {
    test('reads the real answer', () {
      final r = _read('receivables-answer');
      expect(r.kind, SliceReadKind.answer);
      final a = r.answer!;
      expect(a.partyId, 1);
      expect(a.partyName, 'Mokoena');
      expect(a.currency, 'ZAR');
      expect(a.totalMinor, 85000);
      expect(a.totalText, 'R850.00');
      expect(a.lines.length, 1);
      expect(a.lines[0].ref.kind, 'document');
      expect(a.lines[0].ref.id, 1);
      expect(a.lines[0].number, 1);
      expect(a.lines[0].grossMinor, 115000);
      expect(a.lines[0].allocatedMinor, 30000);
      expect(a.lines[0].outstandingMinor, 85000);
      expect(a.lines[0].issuedOn, '2026-10-01');
      expect(a.version, greaterThan(0));
      expect(a.derivedBy, 'ledger.outstandingForParty');
    });

    test('after R500 is approved the total moves to R350.00', () {
      final a = _read('receivables-after-payment').answer!;
      expect(a.totalMinor, 35000);
      expect(a.totalText, 'R350.00');
      expect(a.lines[0].outstandingMinor, 35000);
      expect(a.lines[0].allocatedMinor, 80000);
      expect(a.version, greaterThan(_read('receivables-answer').answer!.version));
    });

    test('an ambiguous name carries the candidates and no figure', () {
      final r = _read('receivables-ambiguous');
      expect(r.kind, SliceReadKind.ambiguous);
      expect(r.answer, isNull);
      expect(r.candidates.map((c) => c.id).toList(), [1, 2]);
    });

    test('a business without the capability is answered honestly, with no figure', () {
      final r = _read('unavailable-ask');
      expect(r.kind, SliceReadKind.unavailable);
      expect(r.answer, isNull);
      expect(r.message, contains('not available'));
      expect(parseReceivables(409, <String, Object?>{'error': 'stale'}).kind, SliceReadKind.unusable);
    });

    test('a refusal and a missing customer carry nothing', () {
      expect(_read('receivables-refused').kind, SliceReadKind.refused);
      expect(_read('receivables-refused').answer, isNull);
      expect(_read('receivables-not-found').kind, SliceReadKind.notFound);
    });

    test('anything unusable is unusable and nothing throws', () {
      expect(parseReceivables(200, null).kind, SliceReadKind.unusable);
      expect(parseReceivables(200, 'text').kind, SliceReadKind.unusable);
      expect(parseReceivables(200, <String, Object?>{}).kind, SliceReadKind.unusable);
      expect(parseReceivables(500, <String, Object?>{'status': 'ok'}).kind, SliceReadKind.unusable);
      expect(parseReceivables(200, <String, Object?>{'status': 'ambiguous', 'candidates': [<String, Object?>{'id': 1, 'name': 'A'}]}).kind, SliceReadKind.unusable);
    });

    test('a figure that is not a whole number makes the answer unusable; a refusal never reads a figure', () {
      final body = _body(_fx('receivables-answer')) as Map<String, Object?>;
      final result = Map<String, Object?>.from(body['result'] as Map);
      result['totalMinor'] = 1380.5;
      expect(parseReceivables(200, <String, Object?>{'status': 'ok', 'result': result}).kind, SliceReadKind.unusable);
      expect(parseReceivables(403, body).kind, SliceReadKind.refused);
      expect(parseReceivables(403, body).answer, isNull);
    });

    test('a very long list is bounded', () {
      final body = _body(_fx('receivables-answer')) as Map<String, Object?>;
      final result = Map<String, Object?>.from(body['result'] as Map);
      final one = (result['documents'] as List).first;
      result['documents'] = List<Object?>.generate(500, (_) => one);
      final r = parseReceivables(200, <String, Object?>{'status': 'ok', 'result': result});
      expect(r.answer!.lines.length, lessThanOrEqualTo(50));
    });
  });

  group('a record opened from the answer', () {
    test('reads the real document view', () {
      final d = _record('record-document')!;
      expect(d.ref.kind, 'document');
      expect(d.ref.id, 1);
      expect(d.title, 'Invoice #1');
      expect(d.version, greaterThan(0));
      final gross = d.fields.firstWhere((f) => f.key == 'grossMinor');
      expect(gross.display, 'R1,150.00');
      expect(gross.derivedBy, 'ledger.documentTotals');
      expect(d.fields.firstWhere((f) => f.key == 'allocatedMinor').display, 'R300.00');
      expect(d.fields.firstWhere((f) => f.key == 'outstandingMinor').display, 'R850.00');
      expect(d.fields.firstWhere((f) => f.key == 'status').display, 'part_paid');
      expect(d.collections['lines']!.length, 1);
      expect(d.collections['lines']!.first['description'], 'Vinyl plank');
      expect(d.relations.first.role, 'customer');
      expect(d.relations.first.ref.kind, 'party');
      expect(d.relations.first.ref.id, 1);
      expect(d.relations.first.label, 'Mokoena');
      expect(d.actions.single.capability, 'payment.record');
      expect(d.actions.single.valid, isTrue);
      expect(d.history.first.type, 'document.issued');
    });

    test('the invoice shows the correction: a reversed allocation and the one that stands', () {
      final d = _record('record-document')!;
      final allocations = d.collections['allocations']!;
      expect(allocations.length, 2);
      expect(allocations.where((a) => a['effective'] == true).length, 1);
      expect(allocations.every((a) => a['amountMinor'] == 30000), isTrue);
      expect(d.history.map((h) => h.type).toList(), ['document.issued', 'payment.allocated', 'payment.allocation_reversed', 'payment.allocated']);
    });

    test('after approval the invoice shows the new allocation of R500.00', () {
      final d = _record('record-document-after-payment')!;
      final allocations = d.collections['allocations']!;
      expect(allocations.length, 3);
      expect(allocations.last['amountMinor'], 50000);
      expect(allocations.last['effective'], isTrue);
      expect(d.fields.firstWhere((f) => f.key == 'outstandingMinor').display, 'R350.00');
    });

    test('after approval the new allocation carries its trail: the capture, the proposal, the approver and the contract', () {
      final d = _record('record-document-after-payment')!;
      final last = d.history.last;
      expect(last.type, 'payment.allocated');
      expect(last.captureId, 2);
      expect(last.proposalId, 1);
      expect(last.approvedBy, 'accountant@example.com');
      expect(last.contract, 'payment.record');
      expect(last.contractVersion, 1);
      expect(last.interpretationId, 1);
      expect(last.interpreter, 'script');
      expect(last.hasTrail, isTrue);
    });

    test('a fact written without a proposal shows no trail rather than an invented one', () {
      final d = _record('record-document')!;
      expect(d.history.every((h) => !h.hasTrail), isTrue);
      expect(d.history.every((h) => h.captureId == null && h.proposalId == null && h.approvedBy == null && h.interpretationId == null && h.interpreter == null), isTrue);
    });

    test('the first payment opens as a record of its own and says it was reversed', () {
      final m = _record('record-movement-reversed')!;
      expect(m.ref.kind, 'movement');
      expect(m.fields.firstWhere((f) => f.key == 'status').display, 'reversed');
      expect(m.fields.firstWhere((f) => f.key == 'amountMinor').display, 'R300.00');
      expect(m.collections['allocations']!.single['effective'], false);
    });

    test('reads the real customer view, the way back up from a document', () {
      final p = _record('record-party')!;
      expect(p.title, 'Mokoena');
      expect(p.relations.length, 2);
      expect(p.collections['documents']!.length, 1);
      expect(p.collections['payments']!.length, 1);
      expect(p.fields.firstWhere((f) => f.key == 'outstandingMinor').display, 'R850.00');
    });

    test('anything that is not an ok view is null, so a hidden record and a missing one look the same', () {
      expect(parseRecord(404, <String, Object?>{'error': 'not_found'}), isNull);
      expect(parseRecord(200, null), isNull);
      expect(parseRecord(200, <String, Object?>{'status': 'ok'}), isNull);
      expect(parseRecord(200, <String, Object?>{'status': 'ok', 'result': <String, Object?>{'title': 'x'}}), isNull);
    });
  });

  group('a payment waiting for approval', () {
    test('reads the exact amount and allocation the approver is approving', () {
      final fx = _fx('pending-held');
      final held = parseHeldPayments(_status(fx), _body(fx));
      expect(held.length, 1);
      expect(held.single.actionId, 1);
      expect(held.single.transcript, 'Record R500 from Mokoena');
      expect(held.single.partyId, 1);
      expect(held.single.amountMinor, 50000);
      expect(held.single.amountText, 'R500.00');
      expect(held.single.occurredOn, '2026-11-07');
      expect(held.single.allocations.length, 1);
      expect(held.single.allocations.single.documentId, 1);
      expect(held.single.allocations.single.amountMinor, 50000);
      expect(held.single.partyVersion, greaterThan(0));
    });

    test('other kinds of held action and unusable payloads are skipped, and nothing throws', () {
      expect(parseHeldPayments(200, <String, Object?>{'pending': [<String, Object?>{'id': 1, 'type': 'invoice', 'payload': '{}'}]}), isEmpty);
      expect(parseHeldPayments(200, <String, Object?>{'pending': [<String, Object?>{'id': 1, 'type': 'engine.payment.record', 'payload': 'not json'}]}), isEmpty);
      expect(parseHeldPayments(200, <String, Object?>{'pending': [<String, Object?>{'id': 1, 'type': 'engine.payment.record', 'payload': '{"partyId":1}'}]}), isEmpty);
      expect(parseHeldPayments(403, <String, Object?>{'error': 'x'}), isEmpty);
      expect(parseHeldPayments(200, null), isEmpty);
    });
  });

  group('proposing and approving a payment', () {
    test('a proposal is held, not recorded', () {
      final p = _proposal('proposal-held');
      expect(p.held, isTrue);
      expect(p.actionId, 1);
    });

    test('a proposal in a business without the capability is refused honestly', () {
      final p = _proposal('unavailable-proposal');
      expect(p.held, isFalse);
      expect(p.error, 'capability_unavailable');
    });

    test('a proposal from a member who may not is refused with the reason', () {
      final p = _proposal('proposal-refused');
      expect(p.held, isFalse);
      expect(p.error, 'not_permitted');
      expect(p.actionId, isNull);
    });

    test('an approval is read, and a stale one is told apart', () {
      expect(_confirm('confirm-ok').ok, isTrue);
      final stale = _confirm('confirm-stale');
      expect(stale.ok, isFalse);
      expect(stale.stale, isTrue);
      expect(parseConfirm(409, <String, Object?>{'error': 'over_allocated'}).stale, isFalse);
      expect(parseConfirm(200, null).ok, isFalse);
    });
  });

  group('the journey', () {
    final answered = const SliceFlow.resting().asked().received(_read('receivables-answer'));

    test('question, answer, drill-down, back to the conversation', () {
      var f = const SliceFlow.resting();
      expect(f.orbPhase, 'idle');
      f = f.asked();
      expect(f.step, SliceStep.asking);
      expect(f.orbPhase, 'thinking');
      f = f.received(_read('receivables-answer'));
      expect(f.step, SliceStep.answered);
      expect(f.answer!.totalMinor, 85000);
      f = f.opened(_record('record-document')!);
      expect(f.step, SliceStep.record);
      expect(f.record!.title, 'Invoice #1');
      expect(f.answer, isNotNull);
      f = f.backToConversation();
      expect(f.step, SliceStep.answered);
      expect(f.record, isNull);
      expect(f.answer!.totalMinor, 85000);
    });

    test('a record can lead to another record and still return to the answer', () {
      var f = answered.opened(_record('record-document')!).opened(_record('record-party')!);
      expect(f.step, SliceStep.record);
      expect(f.record!.title, 'Mokoena');
      f = f.backToConversation();
      expect(f.step, SliceStep.answered);
    });

    test('propose, approve, done', () {
      var f = answered.proposed(_proposal('proposal-held'));
      expect(f.step, SliceStep.held);
      expect(f.orbPhase, 'awaiting');
      expect(f.actionId, 1);
      f = f.approving();
      expect(f.step, SliceStep.approving);
      expect(f.orbPhase, 'executing');
      f = f.confirmed(_confirm('confirm-ok'));
      expect(f.step, SliceStep.done);
      expect(f.orbPhase, 'responding');
    });

    test('a refused proposal is a problem that says why and keeps the answer', () {
      final f = answered.proposed(_proposal('proposal-refused'));
      expect(f.step, SliceStep.problem);
      expect(f.message, isNotNull);
      expect(f.answer, isNotNull);
      expect(f.orbPhase, 'idle');
    });

    test('a stale approval asks the person to look again', () {
      final f = answered.proposed(_proposal('proposal-held')).approving().confirmed(_confirm('confirm-stale'));
      expect(f.step, SliceStep.problem);
      expect(f.needsRefresh, isTrue);
    });

    test('a business without the capability ends honestly, with no answer', () {
      final f = const SliceFlow.resting().asked().received(_read('unavailable-ask'));
      expect(f.step, SliceStep.unavailable);
      expect(f.answer, isNull);
      expect(f.message, contains('not available'));
      expect(f.orbPhase, 'responding');
    });

    test('an ambiguous name, a refusal and a missing customer end where they should', () {
      expect(const SliceFlow.resting().asked().received(_read('receivables-ambiguous')).step, SliceStep.ambiguous);
      expect(const SliceFlow.resting().asked().received(_read('receivables-refused')).step, SliceStep.refused);
      final missing = const SliceFlow.resting().asked().received(_read('receivables-not-found'));
      expect(missing.step, SliceStep.problem);
      expect(missing.answer, isNull);
    });

    test('a transition that does not make sense from here changes nothing', () {
      const rest = SliceFlow.resting();
      expect(rest.received(_read('receivables-answer')).step, SliceStep.resting);
      expect(rest.opened(_record('record-document')!).step, SliceStep.resting);
      expect(rest.approving().step, SliceStep.resting);
      expect(rest.confirmed(_confirm('confirm-ok')).step, SliceStep.resting);
      expect(rest.backToConversation().step, SliceStep.resting);
      expect(answered.approving().step, SliceStep.answered);
      expect(answered.backToConversation().step, SliceStep.answered);
      final held = answered.proposed(_proposal('proposal-held'));
      expect(held.opened(_record('record-document')!).step, SliceStep.held);
      expect(held.received(_read('receivables-answer')).step, SliceStep.held);
    });

    test('a repeated approval cannot record twice from the screen', () {
      final done = answered.proposed(_proposal('proposal-held')).approving().confirmed(_confirm('confirm-ok'));
      expect(done.approving().step, SliceStep.done);
      expect(done.confirmed(_confirm('confirm-ok')).step, SliceStep.done);
    });
  });
}
