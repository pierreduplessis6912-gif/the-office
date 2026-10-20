// Front-end slice 6: the activity record, read from GET /history (RUNBOOK, "History and audit").
//
// History is a RECORD, not the main experience: what was heard, what The Office generated, what was held, what was decided and what was
// written are different things, so they are kept as different things here (the contract keeps them apart on purpose). This reader is
// defensive: parseHistory never throws; anything that is not a version 1 answer is null (the room then says it cannot read it), a turn
// without an integer id is skipped, and lists and strings are bounded so a hostile or very large answer cannot make the app do unbounded work.
import 'analysis_model.dart';

const int _maxTurns = 100;
const int _maxList = 50;
const int _maxLong = 4000;
const int _maxShort = 200;

class HistoryProposed {
  final int id;
  final String? type;
  final String? status;
  const HistoryProposed({required this.id, this.type, this.status});
}

class HistoryDecision {
  final String kind;
  final String? outcome;
  final String? by;
  const HistoryDecision({required this.kind, this.outcome, this.by});
}

class HistoryWritten {
  final String table;
  final int id;
  const HistoryWritten({required this.table, required this.id});
}

class HistoryTurn {
  final int id;
  final String? at;
  final String? source;
  final String? heard; // what was actually said or typed (recorded); null when the recording is no longer on file
  final String? replied; // what The Office generated
  final String? mode;
  final List<HistoryProposed> proposed;
  final List<HistoryDecision> decisions;
  final List<HistoryWritten> recordsWritten;
  final String? actor; // only in the owner's "everyone" view
  final String? viewing; // what the APP said was on screen when this was said (a hint it sent, not something the server established)
  const HistoryTurn({
    required this.id,
    this.at,
    this.source,
    this.heard,
    this.replied,
    this.mode,
    this.proposed = const [],
    this.decisions = const [],
    this.recordsWritten = const [],
    this.actor,
    this.viewing,
  });
}

class HistoryPage {
  final String scope; // 'me' or 'all'
  final List<HistoryTurn> turns;
  final int? next; // pass as `before` to get the following page; null when there is no more
  const HistoryPage({required this.scope, required this.turns, required this.next});
}

/// Reads a decoded GET /history body. Null when it is not a version 1 answer. Never throws.
HistoryPage? parseHistory(Object? body) {
  try {
    if (body is! Map || body['version'] != 1) return null;
    final turns = <HistoryTurn>[];
    final items = body['items'];
    if (items is List) {
      for (final raw in items.take(_maxTurns)) {
        final t = _turn(raw);
        if (t != null) turns.add(t);
      }
    }
    final next = body['next'];
    return HistoryPage(scope: body['scope'] == 'all' ? 'all' : 'me', turns: turns, next: next is int ? next : null);
  } catch (_) {
    return null;
  }
}

HistoryTurn? _turn(Object? raw) {
  if (raw is! Map) return null;
  final id = raw['id'];
  if (id is! int) return null;
  final recorded = raw['recorded'];
  final generated = raw['generated'];
  return HistoryTurn(
    id: id,
    at: _s(raw['at'], _maxShort),
    source: _s(raw['source'], _maxShort),
    heard: recorded is Map ? _s(recorded['heard'], _maxLong) : null,
    replied: generated is Map ? _s(generated['replied'], _maxLong) : null,
    mode: generated is Map ? _s(generated['mode'], _maxShort) : null,
    proposed: [
      for (final p in _list(raw['proposed']))
        if (p is Map && p['id'] is int) HistoryProposed(id: p['id'] as int, type: _s(p['type'], _maxShort), status: _s(p['status'], _maxShort)),
    ],
    decisions: [
      for (final d in _list(raw['decisions']))
        if (d is Map && _s(d['kind'], _maxShort) != null) HistoryDecision(kind: _s(d['kind'], _maxShort)!, outcome: _s(d['outcome'], _maxShort), by: _s(d['by'], _maxShort)),
    ],
    recordsWritten: [
      for (final w in _list(raw['recordsWritten']))
        if (w is Map && _s(w['table'], _maxShort) != null && w['id'] is int) HistoryWritten(table: _s(w['table'], _maxShort)!, id: w['id'] as int),
    ],
    actor: _s(raw['actor'], _maxShort),
    viewing: describeViewing(raw['viewing']),
  );
}

List<Object?> _list(Object? v) => v is List ? v.take(_maxList).toList() : const <Object?>[];

String? _s(Object? v, int max) {
  if (v is! String) return null;
  return v.length > max ? v.substring(0, max) : v;
}

/// "confirmed by you", "rejected by another member", "confirmed by someone@example.com was refused" and so on.
String decisionLine(HistoryDecision d) {
  final who = d.by ?? 'someone';
  return (d.outcome ?? '').startsWith('refused') ? '${d.kind} by $who was refused' : '${d.kind} by $who';
}

/// "invoices x2, customers": what was written from this turn, counted by table.
String recordsLine(List<HistoryWritten> written) {
  final counts = <String, int>{};
  for (final w in written) {
    final name = w.table.replaceAll('_', ' ');
    counts[name] = (counts[name] ?? 0) + 1;
  }
  return counts.entries.map((e) => e.value > 1 ? '${e.key} x${e.value}' : e.key).join(', ');
}

/// The server stamps turns in UTC as "YYYY-MM-DD HH:MM:SS". Returns a UTC DateTime, or null when it cannot be read.
DateTime? parseTurnTime(String? at) {
  if (at == null) return null;
  final p = DateTime.tryParse(at.contains('T') ? at : at.replaceFirst(' ', 'T'));
  if (p == null) return null;
  return p.isUtc ? p : DateTime.utc(p.year, p.month, p.day, p.hour, p.minute, p.second);
}

const List<String> _months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/// "20 Oct 11:24" (the caller decides which zone the DateTime is in).
String formatShort(DateTime d) => '${d.day} ${_months[d.month - 1]} ${d.hour.toString().padLeft(2, '0')}:${d.minute.toString().padLeft(2, '0')}';

/// A plain line for what the app said was on screen: "analysis, profit and loss, 1 Sep to 30 Sep 2026, compared with 2 Aug to 31 Aug 2026,
/// topic expenses". Null when there is nothing readable. Never throws.
String? describeViewing(Object? v) {
  try {
    if (v is! Map) return null;
    final parts = <String>[];
    final room = v['room'];
    if (room is String && room.isNotEmpty) parts.add(room.replaceAll('_', ' '));
    final report = v['report'];
    if (report is String && report.isNotEmpty) parts.add(report.replaceAll('_', ' '));
    final period = parseSpan(v['period']);
    if (period != null) parts.add(spanText(period));
    final compare = parseSpan(v['compare']);
    if (period != null && compare != null) parts.add('compared with ${spanText(compare)}');
    final filters = v['filters'];
    if (filters is Map) {
      for (final e in filters.entries.take(10)) {
        if (e.key is String && (e.value is String || e.value is num || e.value is bool)) parts.add('${(e.key as String).replaceAll('_', ' ')} ${e.value}');
      }
    }
    if (parts.isEmpty) return null;
    final line = parts.join(', ');
    return line.length > 300 ? line.substring(0, 300) : line;
  } catch (_) {
    return null;
  }
}
