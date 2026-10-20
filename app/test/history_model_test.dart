// Front-end slice 6 (lib/history_model.dart). What this pins: a version 1 GET /history answer is read as the contract describes, keeping what
// was HEARD apart from what was GENERATED, and the held actions, decisions and records written beside them; anything that is not a version 1
// answer is null; a turn without an integer id is skipped; hostile shapes never throw; lists and strings are bounded; and the small
// formatting helpers (who decided, what was written, when) say what they should. It does not test the room's layout: that needs a device.
import 'package:flutter_test/flutter_test.dart';
import 'package:the_office/history_model.dart';

Map<String, Object?> _turn({int id = 7, Object? heard = 'invoice Jenny for 1200', Object? replied = 'Invoice drafted.', String scope = 'me'}) => {
      'id': id,
      'at': '2026-10-20 11:24:13',
      'source': 'voice',
      'viewing': null,
      'recorded': {'heard': heard},
      'generated': {'interpreted': {'intent': 'invoice'}, 'replied': replied, 'mode': 'confirm'},
      'proposed': [
        {'id': 12, 'type': 'invoice', 'status': 'confirmed'}
      ],
      'decisions': [
        {'at': '2026-10-20 11:25:00', 'action': 12, 'kind': 'confirmed', 'outcome': 'done', 'by': 'you'}
      ],
      'recordsWritten': [
        {'table': 'invoices', 'id': 40},
        {'table': 'invoices', 'id': 41},
        {'table': 'customers', 'id': 3}
      ],
      if (scope == 'all') 'actor': 'owner@example.com',
    };

Map<String, Object?> _page({List<Object?>? items, Object? next = 6, String scope = 'me', Object? version = 1}) =>
    {'version': version, 'scope': scope, 'items': items ?? [_turn()], 'next': next};

void main() {
  test('a version 1 answer is read, with heard kept apart from generated', () {
    final page = parseHistory(_page())!;
    expect(page.scope, 'me');
    expect(page.next, 6);
    final t = page.turns.single;
    expect(t.id, 7);
    expect(t.heard, 'invoice Jenny for 1200');
    expect(t.replied, 'Invoice drafted.');
    expect(t.mode, 'confirm');
    expect(t.source, 'voice');
    expect(t.proposed.single.type, 'invoice');
    expect(t.proposed.single.status, 'confirmed');
    expect(t.decisions.single.kind, 'confirmed');
    expect(t.decisions.single.by, 'you');
    expect(t.recordsWritten, hasLength(3));
    expect(t.actor, isNull);
  });

  test('the owner view carries who spoke, and next is null on the last page', () {
    final page = parseHistory(_page(items: [_turn(scope: 'all')], scope: 'all', next: null))!;
    expect(page.scope, 'all');
    expect(page.next, isNull);
    expect(page.turns.single.actor, 'owner@example.com');
  });

  test('a deleted recording reads as heard null, and the rest of the turn remains', () {
    final t = parseHistory(_page(items: [_turn(heard: null)]))!.turns.single;
    expect(t.heard, isNull);
    expect(t.replied, 'Invoice drafted.');
    expect(t.proposed, hasLength(1));
  });

  test('anything that is not a version 1 answer is null', () {
    for (final body in <Object?>[null, 'x', 5, <Object?>[], <String, Object?>{}, _page(version: 2), _page(version: '1'), _page(version: null)]) {
      expect(parseHistory(body), isNull, reason: '$body');
    }
  });

  test('a turn without an integer id is skipped; hostile shapes never throw', () {
    final page = parseHistory(_page(items: [
      null, 5, 'x', <Object?>[], {'id': 'seven'}, {'id': 1.5}, {'recorded': {'heard': 'no id'}},
      {'id': 9, 'recorded': 'x', 'generated': 5, 'proposed': 'nope', 'decisions': {'a': 1}, 'recordsWritten': 7},
      {'id': 10, 'proposed': [null, 1, {'id': 'x'}, {'type': 'invoice'}], 'decisions': [{'kind': 5}, {}], 'recordsWritten': [{'table': 'invoices'}, {'id': 1}]},
    ], next: 'later'))!;
    expect(page.turns.map((t) => t.id), [9, 10]);
    expect(page.next, isNull);
    for (final t in page.turns) {
      expect(t.heard, isNull);
      expect(t.proposed, isEmpty);
      expect(t.decisions, isEmpty);
      expect(t.recordsWritten, isEmpty);
    }
  });

  test('turns are cut to 100, lists to 50, strings to 4000 (short fields 200)', () {
    final many = [for (var i = 1; i <= 150; i++) _turn(id: i)];
    expect(parseHistory(_page(items: many))!.turns, hasLength(100));
    final long = 'x' * 9000;
    final t = parseHistory(_page(items: [
      {..._turn(heard: long, replied: long), 'source': long, 'recordsWritten': [for (var i = 0; i < 80; i++) {'table': 't', 'id': i}]}
    ]))!.turns.single;
    expect(t.heard!.length, 4000);
    expect(t.replied!.length, 4000);
    expect(t.source!.length, 200);
    expect(t.recordsWritten, hasLength(50));
  });

  test('decisionLine says who decided, and when it was refused', () {
    expect(decisionLine(const HistoryDecision(kind: 'confirmed', outcome: 'done', by: 'you')), 'confirmed by you');
    expect(decisionLine(const HistoryDecision(kind: 'rejected', by: 'another member')), 'rejected by another member');
    expect(decisionLine(const HistoryDecision(kind: 'edited', outcome: 'refused:403', by: 'a@b.co')), 'edited by a@b.co was refused');
    expect(decisionLine(const HistoryDecision(kind: 'confirmed')), 'confirmed by someone');
  });

  test('recordsLine counts what was written by table', () {
    expect(recordsLine(const [HistoryWritten(table: 'invoices', id: 1), HistoryWritten(table: 'invoices', id: 2), HistoryWritten(table: 'supplier_payments', id: 3)]),
        'invoices x2, supplier payments');
    expect(recordsLine(const []), '');
  });

  test('parseTurnTime reads the server stamp as UTC; formatShort is day, month and 24-hour time', () {
    final t = parseTurnTime('2026-10-20 11:24:13')!;
    expect(t.isUtc, isTrue);
    expect([t.year, t.month, t.day, t.hour, t.minute], [2026, 10, 20, 11, 24]);
    expect(parseTurnTime('2026-10-20T11:24:13Z')!.hour, 11);
    expect(parseTurnTime('not a time'), isNull);
    expect(parseTurnTime(null), isNull);
    expect(formatShort(DateTime.utc(2026, 1, 5, 9, 4)), '5 Jan 09:04');
    expect(formatShort(DateTime.utc(2026, 10, 20, 23, 59)), '20 Oct 23:59');
  });

  test('an app command stored as what The Office said is read as plain text; real speech is untouched', () {
    expect(humanReply('__OPEN_DASHBOARD__:financial_snapshot'), 'Opened financial snapshot');
    expect(humanReply('__OPEN_DASHBOARD__:aged_debtors'), 'Opened aged debtors');
    expect(humanReply('__SOMETHING_NEW__:x'), '(an instruction to the app)');
    expect(humanReply('__OPEN_DASHBOARD__:'), '(an instruction to the app)');
    expect(humanReply('Open __OPEN_DASHBOARD__:aged_debtors now'), 'Open __OPEN_DASHBOARD__:aged_debtors now');
    expect(humanReply('Invoice drafted.'), 'Invoice drafted.');
    expect(humanReply(''), '');
    expect(humanReply(null), isNull);
    final t = parseHistory({'version': 1, 'scope': 'me', 'next': null, 'items': [
      {'id': 1, 'at': '2026-10-20 11:24:13', 'source': 'voice', 'recorded': {'heard': 'what is our financial position'}, 'generated': {'replied': '__OPEN_DASHBOARD__:financial_snapshot', 'mode': 'speak'}, 'proposed': [], 'decisions': [], 'recordsWritten': []},
    ]})!.turns.single;
    expect(t.replied, 'Opened financial snapshot');
  });
}

