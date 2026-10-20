// Front-end slice 8: telling The Office what is on screen (CONTEXT.md, contract version 1).
//
// The context is an untrusted HINT, never a permission: the server validates it against allowlists, records it with the turn as `viewing`
// (so the audit record shows what the app CLAIMED was displayed) and does not use it to interpret speech yet. So this must be strictly
// honest: the app builds a context only for something it is actually showing right now, from what that screen actually loaded, and clears it
// when that is no longer true. It also validates on this side with the server's own rules, so toJson only ever emits parts the server would
// keep, and returns null when there is nothing true and valid to say (then no `context` is sent at all).
import 'analysis_model.dart';

/// The reports the server actually has. The server refuses any other name.
const Set<String> contextReports = {'profit_and_loss', 'aged_debtors', 'aged_creditors'};

final RegExp _slug = RegExp(r'^[a-z][a-z0-9_]{0,31}$');
final RegExp _plain = RegExp(r"^[A-Za-z0-9 _.,'\-]{1,40}$");
const int _maxFilters = 10;
const int _maxSpanDays = 3660;

bool isSlug(String s) => _slug.hasMatch(s);

/// A real calendar date range, `from` not after `to`, at most 3,660 days (the server's rule).
bool isValidSpan(DateSpan s) {
  final a = _realDate(s.from);
  final b = _realDate(s.to);
  if (a == null || b == null || a.isAfter(b)) return false;
  return b.difference(a).inDays + 1 <= _maxSpanDays;
}

DateTime? _realDate(String s) {
  final d = DateTime.tryParse(s);
  return d != null && isoDate(d) == s && s.length == 10 ? DateTime.utc(d.year, d.month, d.day) : null;
}

class WorkspaceContext {
  final String? room;
  final String? report;
  final DateSpan? period;
  final DateSpan? compare;
  final Map<String, Object> filters; // values: a short plain String, a finite number or a bool
  const WorkspaceContext({this.room, this.report, this.period, this.compare, this.filters = const {}});

  /// The `context` object for POST /messages/text, holding only parts the server would keep. Null when there is nothing valid to say.
  Map<String, Object?>? toJson() {
    final out = <String, Object?>{'version': 1};
    final r = room;
    if (r != null && isSlug(r)) out['room'] = r;
    final rep = report;
    if (rep != null && contextReports.contains(rep)) out['report'] = rep;
    final p = period;
    if (p != null && isValidSpan(p)) {
      out['period'] = {'from': p.from, 'to': p.to};
      final c = compare; // a comparison is only meaningful beside a valid period
      if (c != null && isValidSpan(c)) out['compare'] = {'from': c.from, 'to': c.to};
    }
    final kept = <String, Object>{};
    for (final e in filters.entries) {
      if (kept.length >= _maxFilters) break;
      final v = e.value;
      final ok = isSlug(e.key) && ((v is String && _plain.hasMatch(v)) || (v is num && v.isFinite) || v is bool);
      if (ok) kept[e.key] = v;
    }
    if (kept.isNotEmpty) out['filters'] = kept;
    return out.length > 1 ? out : null;
  }
}
