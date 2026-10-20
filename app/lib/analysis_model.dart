// Front-end slice 7: the analysis workspace, read from GET /reports/analysis (RUNBOOK, "Analysis layer").
//
// It answers WHY a profit and loss figure changed, and is honest about what it cannot say: every finding is a fact (read from a record) or
// calculated (arithmetic on report figures), never a cause, and `notEstablished` lists what it does not know. This reader is defensive:
// parseAnalysis never throws and returns null for anything that is not a usable version 1 answer; lists and strings are bounded so a hostile
// or very large answer cannot make the app do unbounded work. The period helpers are pure so they can be tested without a clock.
const int _maxList = 50;
const int _maxText = 400;

class DateSpan {
  final String from; // YYYY-MM-DD
  final String to;
  const DateSpan({required this.from, required this.to});
}

class AnalysisChange {
  final double amount;
  final double? percent;
  const AnalysisChange({required this.amount, this.percent});
}

class AnalysisRecord {
  final int id;
  final String date;
  final double amount;
  final String description;
  const AnalysisRecord({required this.id, required this.date, required this.amount, required this.description});
}

class AnalysisEvidence {
  final String source;
  final int count;
  final double total;
  final bool reconciled; // do the listed records add up to the report's own figure
  final bool truncated; // are there more records than are listed
  final List<AnalysisRecord> records;
  const AnalysisEvidence({required this.source, required this.count, required this.total, required this.reconciled, required this.truncated, required this.records});
}

class AnalysisContributor {
  final String label;
  final String part; // driver, offset or none
  final double current;
  final double previous;
  final AnalysisChange change;
  final double? shareOfChange;
  final AnalysisEvidence? evidence;
  const AnalysisContributor({required this.label, required this.part, required this.current, required this.previous, required this.change, this.shareOfChange, this.evidence});
}

class AnalysisFinding {
  final String statement;
  final String certainty; // fact or calculated: never a cause
  const AnalysisFinding({required this.statement, required this.certainty});
}

class Analysis {
  final String topic; // expenses or profit
  final DateSpan period;
  final DateSpan compare;
  final String metric; // total_expenses or net_profit
  final double current;
  final double previous;
  final AnalysisChange change;
  final List<AnalysisContributor> contributors;
  final List<AnalysisFinding> findings;
  final List<String> notEstablished;
  const Analysis({required this.topic, required this.period, required this.compare, required this.metric, required this.current, required this.previous, required this.change, required this.contributors, required this.findings, required this.notEstablished});
}

/// Reads a decoded GET /reports/analysis body. Null when it is not a usable version 1 answer. Never throws.
Analysis? parseAnalysis(Object? body) {
  try {
    if (body is! Map || body['version'] != 1) return null;
    final topic = body['analysis'];
    if (topic != 'expenses' && topic != 'profit') return null;
    final period = _span(body['period']);
    final compare = _span(body['compare']);
    final summary = body['summary'];
    if (period == null || compare == null || summary is! Map) return null;
    final current = _n(summary['current']);
    final previous = _n(summary['previous']);
    final change = _change(summary['change']);
    final metric = _t(summary['metric']);
    if (current == null || previous == null || change == null || metric == null) return null;
    return Analysis(
      topic: topic as String,
      period: period,
      compare: compare,
      metric: metric,
      current: current,
      previous: previous,
      change: change,
      contributors: [
        for (final c in _list(body['contributors']))
          if (_contributor(c) != null) _contributor(c)!,
      ],
      findings: [
        for (final f in _list(body['findings']))
          if (f is Map && _t(f['statement']) != null) AnalysisFinding(statement: _t(f['statement'])!, certainty: f['certainty'] == 'fact' ? 'fact' : 'calculated'),
      ],
      notEstablished: [for (final k in _list(body['notEstablished'])) if (_t(k) != null) _t(k)!],
    );
  } catch (_) {
    return null;
  }
}

AnalysisContributor? _contributor(Object? raw) {
  if (raw is! Map) return null;
  final label = _t(raw['name']) ?? _t(raw['label']);
  final current = _n(raw['current']);
  final previous = _n(raw['previous']);
  final change = _change(raw['change']);
  if (label == null || current == null || previous == null || change == null) return null;
  final part = raw['part'];
  return AnalysisContributor(
    label: label,
    part: part == 'driver' || part == 'offset' ? part as String : 'none',
    current: current,
    previous: previous,
    change: change,
    shareOfChange: _n(raw['shareOfChange']),
    evidence: _evidence(raw['evidence']),
  );
}

AnalysisEvidence? _evidence(Object? raw) {
  if (raw is! Map) return null;
  final count = raw['count'];
  final total = _n(raw['total']);
  if (count is! int || total == null) return null;
  return AnalysisEvidence(
    source: _t(raw['source']) ?? '',
    count: count,
    total: total,
    reconciled: raw['reconciled'] == true,
    truncated: raw['truncated'] == true,
    records: [
      for (final r in _list(raw['records']))
        if (r is Map && r['id'] is int && _t(r['date']) != null && _n(r['amount']) != null)
          AnalysisRecord(id: r['id'] as int, date: _t(r['date'])!, amount: _n(r['amount'])!, description: _t(r['description']) ?? ''),
    ],
  );
}

final RegExp _isoDate = RegExp(r'^\d{4}-\d{2}-\d{2}$');

DateSpan? _span(Object? raw) {
  if (raw is! Map) return null;
  final from = raw['from'];
  final to = raw['to'];
  if (from is! String || to is! String || !_isoDate.hasMatch(from) || !_isoDate.hasMatch(to)) return null;
  return DateSpan(from: from, to: to);
}

AnalysisChange? _change(Object? raw) {
  if (raw is! Map) return null;
  final amount = _n(raw['amount']);
  if (amount == null) return null;
  return AnalysisChange(amount: amount, percent: _n(raw['percent']));
}

double? _n(Object? v) => v is num && v.isFinite ? v.toDouble() : null;

String? _t(Object? v) {
  if (v is! String) return null;
  return v.length > _maxText ? v.substring(0, _maxText) : v;
}

List<Object?> _list(Object? v) => v is List ? v.take(_maxList).toList() : const <Object?>[];

/// YYYY-MM-DD for a calendar date (the time of day is ignored).
String isoDate(DateTime d) => '${d.year.toString().padLeft(4, '0')}-${d.month.toString().padLeft(2, '0')}-${d.day.toString().padLeft(2, '0')}';

/// The periods the workspace offers. `today` is passed in so this is testable. The comparison is left to the server, which defaults it to
/// the same number of days ending the day before the period starts.
DateSpan? presetPeriod(String id, DateTime today) {
  final t = DateTime(today.year, today.month, today.day);
  switch (id) {
    case 'this_month':
      return DateSpan(from: isoDate(DateTime(t.year, t.month, 1)), to: isoDate(t));
    case 'last_month':
      final first = DateTime(t.year, t.month - 1, 1);
      return DateSpan(from: isoDate(first), to: isoDate(DateTime(t.year, t.month, 0)));
    case 'last_90':
      return DateSpan(from: isoDate(DateTime(t.year, t.month, t.day - 89)), to: isoDate(t));
  }
  return null;
}

/// "R12,400.00" (the server's own style: R, thousands commas, two decimals).
String formatRand(double v) {
  final negative = v < 0;
  final fixed = v.abs().toStringAsFixed(2);
  final dot = fixed.indexOf('.');
  final whole = fixed.substring(0, dot).replaceAllMapped(RegExp(r'\B(?=(\d{3})+(?!\d))'), (_) => ',');
  return '${negative ? '-' : ''}R$whole${fixed.substring(dot)}';
}

/// "up R12,400.00 (18%)", "down R300.00", "unchanged".
String changeText(AnalysisChange c) {
  if (c.amount == 0) return 'unchanged';
  final p = c.percent;
  final pct = p == null ? '' : ' (${_trim(p.abs())}%)';
  return '${c.amount > 0 ? 'up' : 'down'} ${formatRand(c.amount.abs())}$pct';
}

String _trim(double v) {
  final s = v.toStringAsFixed(1);
  return s.endsWith('.0') ? s.substring(0, s.length - 2) : s;
}

const List<String> _months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/// "1 Oct to 20 Oct 2026", or with both years when they differ.
String spanText(DateSpan s) {
  final a = DateTime.tryParse(s.from);
  final b = DateTime.tryParse(s.to);
  if (a == null || b == null) return '${s.from} to ${s.to}';
  final left = '${a.day} ${_months[a.month - 1]}${a.year == b.year ? '' : ' ${a.year}'}';
  return '$left to ${b.day} ${_months[b.month - 1]} ${b.year}';
}

/// What the analysis says it cannot establish, in plain words. An unknown key is shown with its underscores removed, never hidden.
String notEstablishedLine(String key) {
  switch (key) {
    case 'cause_of_the_change':
      return 'Why it changed: the cause is not established.';
    case 'recurring_or_one_off':
      return 'Whether it will recur or was a one-off.';
    case 'business_date':
      return 'When it really happened: periods use the date a record was entered.';
    case 'supplier':
      return 'Which supplier: expense records do not carry one.';
    case 'cash_received':
      return 'Cash received: revenue counts invoices, not payments.';
  }
  return '${key.replaceAll('_', ' ')}: not established.';
}

/// "Total expenses" or "Net profit".
String metricLabel(String metric) => metric == 'net_profit' ? 'Net profit' : metric == 'total_expenses' ? 'Total expenses' : metric.replaceAll('_', ' ');
