// Front-end slice 7 (lib/analysis_model.dart). What this pins: a version 1 analysis (expenses and profit shapes) is read as the server builds
// it, with evidence carrying whether it adds up and whether it is cut short; anything unusable is null and nothing throws; lists and strings
// are bounded; and the helpers the workspace shows (periods, rand amounts, change text, what is not established) say what they should.
// It does not test the sheet's layout: that needs a device.
import 'package:flutter_test/flutter_test.dart';
import 'package:the_office/analysis_model.dart';

Map<String, Object?> _evidence({bool reconciled = true, bool truncated = false}) => {
      'source': 'expenses', 'which': 'current', 'count': 6, 'total': 5950.0, 'reconciled': reconciled, 'truncated': truncated,
      'records': [
        {'id': 1, 'date': '2026-09-12', 'amount': 3200.0, 'description': 'Timber', 'customerId': null},
        {'id': 2, 'date': '2026-09-19', 'amount': 2750, 'description': 'Boards', 'customerId': 4},
      ],
    };

Map<String, Object?> _expenses({Object? version = 1, Object? contributors}) => {
      'analysis': 'expenses', 'version': version, 'certainty': 'calculated', 'currency': 'ZAR',
      'period': {'from': '2026-09-01', 'to': '2026-09-30'}, 'compare': {'from': '2026-08-02', 'to': '2026-08-31'}, 'basis': {},
      'summary': {'metric': 'total_expenses', 'current': 52400.5, 'previous': 40000, 'change': {'amount': 12400.5, 'percent': 31.0}, 'direction': 'up'},
      'contributors': contributors ?? [
        {'name': 'materials', 'kind': 'category', 'current': 30000, 'previous': 21900, 'change': {'amount': 8100, 'percent': 37.0}, 'shareOfChange': 65.3, 'part': 'driver', 'flags': [], 'evidence': _evidence()},
        {'name': 'fuel', 'kind': 'category', 'current': 5000, 'previous': 5300, 'change': {'amount': -300, 'percent': -5.7}, 'shareOfChange': -2.4, 'part': 'offset', 'flags': [], 'evidence': null},
      ],
      'findings': [
        {'statement': 'materials accounts for R8,100.00 of the change (65.3% of it).', 'certainty': 'calculated', 'basis': ['x']},
        {'statement': 'The largest record was R3,200.00 for "Timber".', 'certainty': 'fact', 'basis': ['y']},
      ],
      'notEstablished': ['cause_of_the_change', 'recurring_or_one_off', 'business_date', 'supplier'],
      'limits': {},
    };

Map<String, Object?> _profit() => {
      'analysis': 'profit', 'version': 1, 'certainty': 'calculated', 'currency': 'ZAR',
      'period': {'from': '2026-09-01', 'to': '2026-09-30'}, 'compare': {'from': '2026-08-02', 'to': '2026-08-31'}, 'basis': {},
      'summary': {'metric': 'net_profit', 'current': 9000, 'previous': 15000, 'change': {'amount': -6000, 'percent': -40.0}, 'direction': 'down', 'reconciles': true},
      'contributors': [
        {'label': 'Revenue', 'kind': 'revenue', 'part': 'driver', 'current': 80000, 'previous': 90000, 'change': {'amount': -10000, 'percent': -11.1}, 'effectOnProfit': -10000, 'evidence': _evidence()},
      ],
      'findings': [], 'notEstablished': ['cause_of_the_change', 'cash_received'], 'limits': {},
    };

void main() {
  test('an expenses analysis is read, with evidence that says whether it adds up', () {
    final a = parseAnalysis(_expenses())!;
    expect(a.topic, 'expenses');
    expect(a.metric, 'total_expenses');
    expect(a.current, 52400.5);
    expect(a.change.amount, 12400.5);
    expect(a.period.from, '2026-09-01');
    expect(a.compare.to, '2026-08-31');
    expect(a.contributors.map((c) => c.label), ['materials', 'fuel']);
    expect(a.contributors.first.part, 'driver');
    expect(a.contributors.first.shareOfChange, 65.3);
    expect(a.contributors.first.evidence!.reconciled, isTrue);
    expect(a.contributors.first.evidence!.records, hasLength(2));
    expect(a.contributors.first.evidence!.records.last.amount, 2750.0);
    expect(a.contributors.last.evidence, isNull);
    expect(a.findings.map((f) => f.certainty), ['calculated', 'fact']);
    expect(a.notEstablished, contains('supplier'));
  });

  test('a profit analysis is read too (contributors are labelled, not named)', () {
    final a = parseAnalysis(_profit())!;
    expect(a.topic, 'profit');
    expect(a.metric, 'net_profit');
    expect(a.change.amount, -6000);
    expect(a.contributors.single.label, 'Revenue');
  });

  test('evidence that does not add up, or is cut short, says so', () {
    final a = parseAnalysis(_expenses(contributors: [
      {'name': 'x', 'current': 1, 'previous': 0, 'change': {'amount': 1}, 'part': 'driver', 'evidence': _evidence(reconciled: false, truncated: true)},
    ]))!;
    expect(a.contributors.single.evidence!.reconciled, isFalse);
    expect(a.contributors.single.evidence!.truncated, isTrue);
  });

  test('anything unusable is null: not v1, wrong topic, bad period, no summary', () {
    final bad = <Object?>[
      null, 'x', 5, <Object?>[], <String, Object?>{}, _expenses(version: 2), _expenses(version: '1'),
      {..._expenses(), 'analysis': 'revenue'}, {..._expenses(), 'period': {'from': '2026-9-1', 'to': '2026-09-30'}},
      {..._expenses(), 'compare': null}, {..._expenses(), 'summary': 'x'},
      {..._expenses(), 'summary': {'metric': 'total_expenses', 'current': 'lots', 'previous': 1, 'change': {'amount': 1}}},
    ];
    for (final b in bad) {
      expect(parseAnalysis(b), isNull, reason: '$b');
    }
  });

  test('hostile contributors, findings and records never throw and are skipped', () {
    final a = parseAnalysis({
      ..._expenses(),
      'contributors': [null, 1, 'x', {'name': 5}, {'name': 'a', 'current': 'x'}, {'name': 'b', 'current': 1, 'previous': 1, 'change': {'amount': 0}, 'evidence': {'count': 'many'}}],
      'findings': [null, 3, {'statement': 5}, {}],
      'notEstablished': [1, null, {}, 'supplier'],
    })!;
    expect(a.contributors.map((c) => c.label), ['b']);
    expect(a.contributors.single.evidence, isNull);
    expect(a.findings, isEmpty);
    expect(a.notEstablished, ['supplier']);
  });

  test('lists are cut to 50 and strings to 400 characters', () {
    final many = [for (var i = 0; i < 80; i++) {'name': 'c$i', 'current': 1, 'previous': 1, 'change': {'amount': 0}}];
    expect(parseAnalysis(_expenses(contributors: many))!.contributors, hasLength(50));
    final long = 'x' * 900;
    final a = parseAnalysis({..._expenses(), 'findings': [{'statement': long, 'certainty': 'fact'}]})!;
    expect(a.findings.single.statement.length, 400);
  });

  test('periods: this month so far, last month, last 90 days (calendar, across year ends)', () {
    final today = DateTime(2026, 10, 20, 15, 30);
    expect(presetPeriod('this_month', today)!.from, '2026-10-01');
    expect(presetPeriod('this_month', today)!.to, '2026-10-20');
    expect(presetPeriod('last_month', today)!.from, '2026-09-01');
    expect(presetPeriod('last_month', today)!.to, '2026-09-30');
    expect(presetPeriod('last_month', DateTime(2026, 1, 15))!.from, '2025-12-01');
    expect(presetPeriod('last_month', DateTime(2026, 1, 15))!.to, '2025-12-31');
    expect(presetPeriod('last_month', DateTime(2028, 3, 5))!.to, '2028-02-29');
    expect(presetPeriod('last_90', today)!.from, '2026-07-23');
    expect(presetPeriod('last_90', today)!.to, '2026-10-20');
    expect(presetPeriod('nonsense', today), isNull);
  });

  test('rand amounts and change text follow the server\'s style', () {
    expect(formatRand(12400.5), 'R12,400.50');
    expect(formatRand(0), 'R0.00');
    expect(formatRand(1234567.891), 'R1,234,567.89');
    expect(formatRand(-300), '-R300.00');
    expect(changeText(const AnalysisChange(amount: 12400.5, percent: 31.0)), 'up R12,400.50 (31%)');
    expect(changeText(const AnalysisChange(amount: -300, percent: -5.7)), 'down R300.00 (5.7%)');
    expect(changeText(const AnalysisChange(amount: 120)), 'up R120.00');
    expect(changeText(const AnalysisChange(amount: 0, percent: 0)), 'unchanged');
  });

  test('spans read as dates, and what is not established is said plainly (an unknown key is still shown)', () {
    expect(spanText(const DateSpan(from: '2026-09-01', to: '2026-09-30')), '1 Sep to 30 Sep 2026');
    expect(spanText(const DateSpan(from: '2025-12-01', to: '2026-01-15')), '1 Dec 2025 to 15 Jan 2026');
    expect(spanText(const DateSpan(from: 'x', to: 'y')), 'x to y');
    expect(notEstablishedLine('cause_of_the_change'), contains('cause'));
    expect(notEstablishedLine('some_new_thing'), 'some new thing: not established.');
    expect(metricLabel('net_profit'), 'Net profit');
    expect(metricLabel('total_expenses'), 'Total expenses');
  });
}
