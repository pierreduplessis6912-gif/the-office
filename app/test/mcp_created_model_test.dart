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
}
