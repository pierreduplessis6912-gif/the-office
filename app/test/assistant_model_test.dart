// The assistant model (lib/engine/assistant_model.dart). What this pins: the readers understand the engine's REAL answers (the assistant-* files in test/fixtures/slice, which tools/slice-mokoena.test.js keeps equal to what the engine
// answers); a read is an answer, a write is HELD with exactly what the approver would approve (the totals are the engine's, never worked out here); anything unusable is reported as such and nothing throws; lists and text are bounded.
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:the_office/engine/assistant_model.dart';

Map<String, Object?> _fx(String name) => jsonDecode(File('test/fixtures/slice/$name.json').readAsStringSync()) as Map<String, Object?>;
AssistantTurn _turn(String name) => parseInterpret(_fx(name)['status'] as int, _fx(name)['body']);
HeldAction _held(String name, int id) => parseHeld(_fx(name)['status'] as int, _fx(name)['body'], id)!;
String _value(List<HeldLine> lines, String label) => lines.firstWhere((l) => l.label == label, orElse: () => const HeldLine('', 'MISSING')).value;

void main() {
  group('reads are answers', () {
    test('finding a party', () {
      final t = _turn('assistant-parties');
      expect(t.kind, AssistantKind.parties);
      expect(t.capability, 'parties.find');
      expect(t.parties.length, 1);
      expect(t.parties.first.name, 'Patel Builders');
      expect(t.parties.first.roles, 'customer');
    });

    test('the VAT summary carries the engine\'s own figures', () {
      final raw = ((_fx('assistant-vat')['body'] as Map)['result']) as Map;
      final t = _turn('assistant-vat');
      expect(t.kind, AssistantKind.vat);
      expect(t.vat!.from, '2026-10-01');
      expect(t.vat!.to, '2026-10-31');
      expect(t.vat!.field1Minor, raw['field1Minor']);
      expect(t.vat!.field4Minor, raw['field4Minor']);
      expect(t.vat!.inputTaxMinor, raw['inputTaxMinor']);
      expect(t.vat!.netVatMinor, raw['netVatMinor']);
      expect(t.vat!.notes.isNotEmpty, isTrue);
    });

    test('expenses', () {
      final t = _turn('assistant-expenses');
      expect(t.kind, AssistantKind.expenses);
      expect(t.capability, 'expenses.find');
    });
  });

  group('writes are held', () {
    test('an expense is held with its action number', () {
      final t = _turn('assistant-held-expense');
      expect(t.kind, AssistantKind.held);
      expect(t.capability, 'expense.record');
      expect(t.actionId, 2);
    });

    test('a party is held', () {
      final t = _turn('assistant-held-party');
      expect(t.kind, AssistantKind.held);
      expect(t.actionId, 1);
    });

    test('what the approver would approve for an expense: the engine\'s totals, formatted, with the supplier named from a record read', () {
      final h = _held('assistant-pending-expense', 2);
      expect(h.type, 'engine.expense.record');
      expect(heldTitle(h.type), 'Record an expense');
      final lines = heldLines(h, names: const <int, String>{3: 'Timber Supplies'});
      expect(_value(lines, 'Supplier'), 'Timber Supplies');
      expect(_value(lines, 'Category'), 'materials');
      expect(_value(lines, 'Paid by'), 'eft');
      expect(_value(lines, 'Amount paid'), 'R230.00');
      expect(_value(lines, 'Before tax'), 'R200.00');
      expect(_value(lines, 'Tax'), 'R30.00');
      expect(_value(lines, 'Total'), 'R230.00');
      expect(_value(lines, 'Tax invoice held'), 'Yes');
    });

    test('without a name the supplier is shown by number, never invented', () {
      final lines = heldLines(_held('assistant-pending-expense', 2));
      expect(_value(lines, 'Supplier'), 'Supplier #3');
    });

    test('what the approver would approve for a new party', () {
      final h = _held('assistant-pending-party', 1);
      expect(heldTitle(h.type), 'Add a customer or supplier');
      final lines = heldLines(h);
      expect(_value(lines, 'Name'), 'Dlamini Timber');
      expect(_value(lines, 'Role'), 'supplier');
      expect(_value(lines, 'Kind'), 'organisation');
    });

    test('any other held write shows its plain fields, money formatted, nothing invented', () {
      const h = HeldAction(id: 9, type: 'engine.credit_note.void', payload: <String, Object?>{'creditNoteId': 3, 'reason': 'wrong customer', 'amountMinor': 5000, 'lines': <Object?>[1], 'basedOn': <String, Object?>{'creditVersion': 4}}, transcript: '');
      expect(heldTitle(h.type), 'credit note void');
      final lines = heldLines(h);
      expect(_value(lines, 'Reason'), 'wrong customer');
      expect(_value(lines, 'Amount'), 'R50.00');
      expect(_value(lines, 'Credit note id'), '3');
      expect(lines.any((l) => l.label.toLowerCase().contains('based')), isFalse);
    });

    test('reading the pending list for the wrong number, or a damaged payload, finds nothing', () {
      expect(parseHeld(200, _fx('assistant-pending-expense')['body'], 99), isNull);
      expect(parseHeld(200, <String, Object?>{'pending': <Object?>[<String, Object?>{'id': 2, 'type': 'engine.expense.record', 'payload': '{not json'}]}, 2), isNull);
      expect(parseHeld(500, null, 2), isNull);
    });
  });

  group('honest refusals', () {
    test('not understood', () {
      final t = _turn('assistant-not-understood');
      expect(t.kind, AssistantKind.notUnderstood);
      expect(t.message, contains('did not understand'));
    });

    test('a supplier who does not exist is refused with the engine\'s own words', () {
      final t = _turn('assistant-refused');
      expect(t.kind, AssistantKind.refused);
      expect(t.message, contains('Nobody Ltd'));
    });

    test('a restricted member is refused', () {
      final t = _turn('assistant-refused-installer');
      expect(t.kind, AssistantKind.refused);
      expect(t.message, isNotNull);
    });
  });

  group('defensive reading', () {
    test('anything unusable is reported as such and nothing throws', () {
      expect(parseInterpret(200, null).kind, AssistantKind.unusable);
      expect(parseInterpret(200, 'text').kind, AssistantKind.unusable);
      expect(parseInterpret(200, <String, Object?>{'status': 'ok'}).kind, AssistantKind.unusable);
      expect(parseInterpret(200, <String, Object?>{'status': 'held'}).kind, AssistantKind.unusable);
      expect(parseInterpret(200, <String, Object?>{'status': 'ok', 'understood': <String, Object?>{'capability': 'vat.summary'}, 'result': <String, Object?>{'field1Minor': 'a lot'}}).kind, AssistantKind.unusable);
      expect(parseInterpret(500, null).kind, AssistantKind.unusable);
    });

    test('lists and text are bounded', () {
      final many = <Object?>[for (var i = 1; i <= 200; i++) <String, Object?>{'id': i, 'name': 'Customer $i', 'roles': <Object?>['customer']}];
      final t = parseInterpret(200, <String, Object?>{'status': 'ok', 'understood': <String, Object?>{'capability': 'parties.find'}, 'result': <String, Object?>{'parties': many}});
      expect(t.parties.length, 50);
      final long = parseInterpret(200, <String, Object?>{'status': 'ok', 'understood': <String, Object?>{'capability': 'parties.find'}, 'result': <String, Object?>{'parties': <Object?>[<String, Object?>{'id': 1, 'name': 'x' * 5000, 'roles': <Object?>[]}]}});
      expect(long.parties.first.name.length, 400);
    });

    test('a choice between several suppliers is a question, not an answer', () {
      final t = parseInterpret(200, <String, Object?>{'status': 'ok', 'understood': <String, Object?>{'capability': 'expense.record'}, 'result': <String, Object?>{'parties': <Object?>[<String, Object?>{'id': 4, 'name': 'Tile Warehouse', 'roles': <Object?>['supplier']}, <String, Object?>{'id': 5, 'name': 'Tile Wholesalers', 'roles': <Object?>['supplier']}]}});
      expect(t.kind, AssistantKind.ambiguous);
      expect(t.parties.length, 2);
    });
  });

  group('the decision', () {
    test('confirming and declining say what happened, and a refusal says why', () {
      expect(parseDecision(200, _fx('assistant-confirm-expense')['body'], confirmed: true).message, 'Done: it is now recorded.');
      expect(parseDecision(200, _fx('reject-ok')['body'], confirmed: false).message, 'Declined: nothing was recorded.');
      final stale = parseDecision(_fx('confirm-stale')['status'] as int, _fx('confirm-stale')['body'], confirmed: true);
      expect(stale.ok, isFalse);
      expect(stale.message.isNotEmpty, isTrue);
      expect(parseDecision(200, null, confirmed: true).ok, isFalse);
    });
  });
}
