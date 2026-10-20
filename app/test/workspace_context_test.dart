// Front-end slice 8 (lib/workspace_context.dart, CONTEXT.md). What this pins: the context the app sends holds only parts the server would
// keep (the server's own rules, applied here first), so a wrong claim cannot be sent by accident: a slug room, a report the server has, real
// calendar dates in order and within 3,660 days, a comparison only beside a valid period, at most 10 filters with plain values; and when
// nothing true and valid remains there is no context at all. It also pins how the Activity room reads the `viewing` the server hands back.
import 'package:flutter_test/flutter_test.dart';
import 'package:the_office/analysis_model.dart';
import 'package:the_office/history_model.dart';
import 'package:the_office/workspace_context.dart';

const _sep = DateSpan(from: '2026-09-01', to: '2026-09-30');
const _aug = DateSpan(from: '2026-08-02', to: '2026-08-31');

void main() {
  test('what the analysis sheet shows is sent in the contract\'s shape', () {
    final json = const WorkspaceContext(room: 'analysis', report: 'profit_and_loss', period: _sep, compare: _aug, filters: {'topic': 'expenses'}).toJson()!;
    expect(json, {
      'version': 1,
      'room': 'analysis',
      'report': 'profit_and_loss',
      'period': {'from': '2026-09-01', 'to': '2026-09-30'},
      'compare': {'from': '2026-08-02', 'to': '2026-08-31'},
      'filters': {'topic': 'expenses'},
    });
  });

  test('every part is optional, and a context with nothing valid in it is null (so no context is sent)', () {
    expect(const WorkspaceContext(room: 'finance').toJson(), {'version': 1, 'room': 'finance'});
    expect(const WorkspaceContext().toJson(), isNull);
    expect(const WorkspaceContext(room: 'Bad Room', report: 'nonsense', period: DateSpan(from: 'x', to: 'y'), filters: {'Bad Key': 'x'}).toJson(), isNull);
  });

  test('a room must be a lower-case slug; a report must be one the server has', () {
    for (final room in ['analysis', 'a', 'room_2', 'a' * 32]) {
      expect(WorkspaceContext(room: room).toJson(), isNotNull, reason: room);
    }
    for (final room in ['', 'Analysis', '2room', 'my room', 'a' * 33, 'room-1']) {
      expect(WorkspaceContext(room: room).toJson(), isNull, reason: room);
    }
    for (final r in contextReports) {
      expect(WorkspaceContext(report: r).toJson()!['report'], r);
    }
    expect(const WorkspaceContext(report: 'balance_sheet').toJson(), isNull);
  });

  test('a period must be real dates, in order, within 3,660 days counting both ends', () {
    expect(isValidSpan(_sep), isTrue);
    expect(isValidSpan(const DateSpan(from: '2026-09-30', to: '2026-09-30')), isTrue);
    expect(isValidSpan(const DateSpan(from: '2026-09-30', to: '2026-09-01')), isFalse);
    expect(isValidSpan(const DateSpan(from: '2026-02-30', to: '2026-03-05')), isFalse);
    expect(isValidSpan(const DateSpan(from: '2026-9-1', to: '2026-09-30')), isFalse);
    expect(isValidSpan(const DateSpan(from: '', to: '')), isFalse);
    final start = DateTime.utc(2016, 1, 1);
    expect(isValidSpan(DateSpan(from: '2016-01-01', to: isoDate(start.add(const Duration(days: 3659))))), isTrue);
    expect(isValidSpan(DateSpan(from: '2016-01-01', to: isoDate(start.add(const Duration(days: 3660))))), isFalse);
  });

  test('a comparison is only sent beside a valid period, and an invalid comparison does not cost the period', () {
    expect(const WorkspaceContext(room: 'analysis', compare: _aug).toJson()!.containsKey('compare'), isFalse);
    expect(const WorkspaceContext(period: DateSpan(from: '2026-09-30', to: '2026-09-01'), compare: _aug).toJson(), isNull);
    final json = const WorkspaceContext(period: _sep, compare: DateSpan(from: 'bad', to: 'bad')).toJson()!;
    expect(json['period'], isNotNull);
    expect(json.containsKey('compare'), isFalse);
  });

  test('filters: slug keys; plain short strings, finite numbers or booleans; at most 10', () {
    final json = const WorkspaceContext(room: 'x', filters: {
      'status': 'outstanding', 'min_amount': 500, 'include_vat': true, 'note': "Bob's, Co. - 2", 'ratio': 0.25,
      'Bad Key': 'x', '9starts': 'x', 'script': '<script>', 'long': 'x' * 41, 'empty': '', 'nan': double.nan, 'inf': double.infinity,
    }).toJson()!['filters']! as Map;
    expect(json.keys, ['status', 'min_amount', 'include_vat', 'note', 'ratio']);
    final eleven = {for (var i = 0; i < 15; i++) 'k$i': 'v'};
    expect((WorkspaceContext(room: 'x', filters: eleven).toJson()!['filters']! as Map).length, 10);
    expect(const WorkspaceContext(room: 'x', filters: {'a': 'x' * 40}).toJson()!['filters'], {'a': 'x' * 40});
  });

  test('only contract fields are ever emitted', () {
    final json = const WorkspaceContext(room: 'analysis', report: 'aged_debtors', period: _sep, compare: _aug, filters: {'topic': 'profit'}).toJson()!;
    expect(json.keys.toSet().difference({'version', 'room', 'report', 'period', 'compare', 'filters', 'sort', 'selection'}), isEmpty);
    expect(json['version'], 1);
  });

  test('the Activity room reads what the app said was on screen, as a plain line', () {
    expect(describeViewing({'version': 1, 'room': 'analysis', 'report': 'profit_and_loss', 'period': {'from': '2026-09-01', 'to': '2026-09-30'}, 'compare': {'from': '2026-08-02', 'to': '2026-08-31'}, 'filters': {'topic': 'expenses'}}),
        'analysis, profit and loss, 1 Sep to 30 Sep 2026, compared with 2 Aug to 31 Aug 2026, topic expenses');
    expect(describeViewing({'room': 'finance'}), 'finance');
    for (final v in <Object?>[null, 'x', 5, <Object?>[], <String, Object?>{}, {'room': 5}, {'period': 'x'}, {'filters': 'x'}]) {
      expect(describeViewing(v), isNull, reason: '$v');
    }
    expect(describeViewing({'room': 'x' * 900})!.length, 300);
  });

  test('a history turn carries what was on screen beside, not inside, what was heard', () {
    final page = parseHistory({
      'version': 1, 'scope': 'me', 'next': null,
      'items': [
        {'id': 1, 'at': '2026-10-20 11:24:13', 'source': 'text', 'viewing': {'room': 'analysis', 'report': 'profit_and_loss'}, 'recorded': {'heard': 'why did expenses go up'}, 'generated': {'replied': 'ok', 'mode': 'speak'}, 'proposed': [], 'decisions': [], 'recordsWritten': []},
        {'id': 2, 'at': '2026-10-20 11:30:00', 'source': 'text', 'viewing': null, 'recorded': {'heard': 'hello'}, 'generated': {}, 'proposed': [], 'decisions': [], 'recordsWritten': []},
      ],
    })!;
    expect(page.turns[0].viewing, 'analysis, profit and loss');
    expect(page.turns[0].heard, 'why did expenses go up');
    expect(page.turns[1].viewing, isNull);
  });
}
