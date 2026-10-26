// The owner's view of what connected assistants created (lib/mcp_created_model.dart; backend worker/src/mcp-undo.ts). What this pins: the list is read exactly as the backend sends it (a real tag id, a known kind and state, nothing hostile), only an active record can be undone, and the words after an undo are the backend's own plain reason.
import 'package:flutter_test/flutter_test.dart';
import 'package:the_office/mcp_created_model.dart';

Map<String, Object?> _item({Object? id = 3, Object? callId = 7, Object? kind = 'invoice', Object? state = 'active', Object? recordId = 313, Object? connection = 'Claude on my phone', Object? summary = const {'description': 'Carpet repair', 'amount': 3000, 'status': 'issued'}}) =>
    {'id': id, 'callId': callId, 'keyId': 'k1', 'connection': connection, 'kind': kind, 'recordId': recordId, 'createdAt': '2026-10-26 11:24:13', 'state': state, 'undoneAt': null, 'summary': summary};

void main() {
  test('the list is read: tag id, call, connection, kind, record, state, description and amount', () {
    final list = parseCreatedList({'items': [_item(), _item(id: 2, kind: 'payment', summary: {'amount': 500.5})]})!;
    expect(list, hasLength(2));
    expect(list.first.id, 3);
    expect(list.first.callId, 7);
    expect(list.first.connection, 'Claude on my phone');
    expect(list.first.kind, 'invoice');
    expect(list.first.recordId, 313);
    expect(list.first.description, 'Carpet repair');
    expect(list.first.amount, 3000.0);
    expect(list.last.description, isNull);
    expect(list.last.amount, 500.5);
  });

  test('anything that is not a list answer is null; hostile or unknown entries are skipped and nothing throws', () {
    for (final b in <Object?>[null, 'x', 5, <Object?>[], <String, Object?>{}, {'items': 'no'}, {'items': {'a': 1}}]) {
      expect(parseCreatedList(b), isNull, reason: '$b');
    }
    final skipped = parseCreatedList({
      'items': [null, 5, 'x', _item(id: 0), _item(id: -1), _item(id: '3'), _item(id: 1.5), _item(callId: null), _item(recordId: 0), _item(kind: 'customer'), _item(kind: 5), _item(state: 'deleted'), _item(state: null), _item(summary: 'x'), _item(summary: {'amount': 'big', 'description': 5}), _item(connection: 5), _item(connection: '   ')]
    })!;
    expect(skipped, hasLength(4));
    expect(skipped[0].description, isNull);
    expect(skipped[1].amount, isNull);
    expect(skipped[1].description, isNull);
    expect(skipped[2].connection, 'a connected assistant');
    expect(skipped[3].connection, 'a connected assistant');
  });

  test('only a record that is still there and not yet undone can be undone', () {
    final byState = {for (final s in ['active', 'undone', 'void', 'gone']) s: parseCreatedList({'items': [_item(state: s)]})!.single};
    expect(byState['active']!.canUndo, isTrue);
    for (final s in ['undone', 'void', 'gone']) {
      expect(byState[s]!.canUndo, isFalse, reason: s);
    }
  });

  test('the title and subtitle say what it is, how much, who made it and when; the state label says what happened instead of an Undo button', () {
    final inv = parseCreatedList({'items': [_item()]})!.single;
    expect(createdTitle(inv), 'Invoice: Carpet repair, R3,000.00');
    expect(createdSubtitle(inv), contains('Claude on my phone'));
    expect(RegExp(r'\d+ Oct').hasMatch(createdSubtitle(inv)), isTrue);
    final bare = parseCreatedList({'items': [_item(kind: 'task', summary: null)]})!.single;
    expect(createdTitle(bare), 'Task');
    expect(stateLabel(inv), '');
    expect(stateLabel(parseCreatedList({'items': [_item(state: 'undone')]})!.single), 'VOIDED');
    expect(stateLabel(parseCreatedList({'items': [_item(kind: 'expense', state: 'undone')]})!.single), 'REMOVED');
    expect(stateLabel(parseCreatedList({'items': [_item(state: 'void')]})!.single), 'VOID');
    expect(stateLabel(parseCreatedList({'items': [_item(state: 'gone')]})!.single), 'NO LONGER THERE');
  });

  test('after an undo the words are the backend\'s plain reason, or a safe fallback, and nothing throws', () {
    expect(undoMessage(200, {'ok': true, 'action': 'voided'}), 'Voided. The invoice keeps its number.');
    expect(undoMessage(200, {'ok': true, 'action': 'removed'}), 'Removed. A copy was kept.');
    expect(undoMessage(409, {'ok': false, 'reason': 'blocked', 'message': 'A payment has been recorded against this invoice. Remove the payment first.'}), 'A payment has been recorded against this invoice. Remove the payment first.');
    expect(undoMessage(404, {'error': 'That is not something a connected assistant created.'}), 'That is not something a connected assistant created.');
    expect(undoMessage(403, null), 'Only the owner can undo this.');
    expect(undoMessage(404, 'x'), 'That is not something an assistant created.');
    expect(undoMessage(500, <Object?>[]), 'Could not undo that right now.');
    expect(undoMessage(200, {'ok': false}), 'Could not undo that right now.');
    expect(undoMessage(409, {'message': 5}), 'Could not undo that right now.');
  });

  Map<String, Object?> change({Object? id = 4, Object? kind = 'invoice', Object? recordId = 313, Object? field = 'amount', Object? oldValue = '3000', Object? newValue = '3500', Object? state = 'active', Object? flagged = false, Object? connection = 'Claude on my phone'}) =>
      {'id': id, 'connection': connection, 'kind': kind, 'recordId': recordId, 'field': field, 'oldValue': oldValue, 'newValue': newValue, 'createdAt': '2026-10-26 11:24:13', 'flagged': flagged, 'state': state};

  test('changes are read: id, kind, record, field, old and new value, state, flag', () {
    final list = parseChangeList({'changes': [change(), change(id: 5, state: 'reverted', flagged: true)]});
    expect(list, hasLength(2));
    expect(list.first.id, 4);
    expect(list.first.kind, 'invoice');
    expect(list.first.recordId, 313);
    expect(list.first.field, 'amount');
    expect(list.first.oldValue, '3000');
    expect(list.first.newValue, '3500');
    expect(list.first.canRevert, isTrue);
    expect(list.last.canRevert, isFalse);
    expect(list.last.flagged, isTrue);
  });

  test('anything that is not a changes answer is an empty list; hostile or unknown entries are skipped; nothing throws', () {
    for (final b in <Object?>[null, 'x', 5, <Object?>[], <String, Object?>{}, {'changes': 'no'}, {'changes': {'a': 1}}]) {
      expect(parseChangeList(b), isEmpty, reason: '$b');
    }
    final skipped = parseChangeList({
      'changes': [null, 5, 'x', change(id: 0), change(id: '4'), change(id: 1.5), change(recordId: 0), change(kind: 'customer'), change(kind: 5), change(field: 'status'), change(field: 'customer_id'), change(field: 5), change(state: 'deleted'), change(state: null), change(oldValue: null), change(oldValue: 5, newValue: 7), change(connection: '   ')]
    });
    expect(skipped, hasLength(3));
    expect(skipped[0].oldValue, isNull);
    expect(skipped[1].oldValue, isNull);
    expect(skipped[1].newValue, isNull);
    expect(skipped[2].connection, 'a connected assistant');
  });

  test('the title says what changed and from what to what: money, done, a date, words', () {
    expect(changeTitle(parseChangeList({'changes': [change()]}).single), 'Invoice 313: amount R3,000.00 \u2192 R3,500.00');
    expect(changeTitle(parseChangeList({'changes': [change(kind: 'task', recordId: 8, field: 'done', oldValue: '0', newValue: '1')]}).single), 'Task 8: done not done \u2192 done');
    expect(changeTitle(parseChangeList({'changes': [change(kind: 'job', recordId: 12, field: 'scheduled_date', oldValue: null, newValue: '2026-11-03')]}).single), 'Job 12: scheduled nothing \u2192 3 Nov');
    expect(changeTitle(parseChangeList({'changes': [change(kind: 'expense', recordId: 2, field: 'description', oldValue: 'fuel', newValue: 'fuel Tuesday')]}).single), 'Expense 2: description fuel \u2192 fuel Tuesday');
    final long = parseChangeList({'changes': [change(field: 'description', newValue: 'x' * 150)]}).single;
    expect(changeTitle(long).length, lessThan(140));
    expect(changeSubtitle(parseChangeList({'changes': [change(flagged: true)]}).single), contains('FLAGGED'));
    expect(changeSubtitle(parseChangeList({'changes': [change()]}).single), isNot(contains('FLAGGED')));
    expect(changeStateLabel(parseChangeList({'changes': [change(state: 'reverted')]}).single), 'REVERTED');
    expect(changeStateLabel(parseChangeList({'changes': [change()]}).single), '');
  });

  test('after a revert the words are the backend\'s plain reason, or a safe fallback', () {
    expect(revertMessage(200, {'ok': true}), 'Put back.');
    expect(revertMessage(409, {'ok': false, 'reason': 'changed_since', 'message': 'That was changed again since, so it was left as it is.'}), 'That was changed again since, so it was left as it is.');
    expect(revertMessage(403, null), 'Only the owner can revert this.');
    expect(revertMessage(404, 'x'), 'That is not a change an assistant made.');
    expect(revertMessage(500, <Object?>[]), 'Could not revert that right now.');
    expect(revertMessage(200, {'ok': false}), 'Could not revert that right now.');
  });
}

