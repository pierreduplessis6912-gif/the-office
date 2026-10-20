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

  Map<String, Object?> recv({Object? version = 1, Object? invoices, Object? unapplied = 0, bool truncated = false}) => {
        'report': 'customer_receivables', 'version': version, 'certainty': 'calculated', 'currency': 'ZAR', 'asAt': '2026-10-20',
        'customer': {'id': 12, 'name': 'Jenny'},
        'basis': {'aging': 'Age counts from the date each invoice was entered.', 'allocation': 'Payments are applied to the oldest invoices first, so which invoice a payment settled is a calculation, not a record.'},
        'facts': ['id', 'date', 'description', 'amount'], 'calculated': ['applied', 'outstanding', 'ageDays', 'bucket'],
        'buckets': {'current': 500.5, 'days30': 1500, 'days60': 0, 'days90Plus': 0, 'total': 2000.5}, 'payments': {'total': 1500, 'count': 1}, 'unappliedPayments': unapplied,
        'invoiceCount': 3, 'outstandingCount': 2, 'truncated': truncated, 'reconciles': true,
        'invoices': invoices ?? [
          {'id': 2, 'date': '2026-09-05', 'description': 'Mid floor', 'amount': 2000, 'applied': 500, 'outstanding': 1500, 'ageDays': 45, 'bucket': 'days30'},
          {'id': 3, 'date': '2026-10-10', 'description': 'New skirting', 'amount': 500.5, 'applied': 0, 'outstanding': 500.5, 'ageDays': 10, 'bucket': 'current'},
        ],
        'notEstablished': ['payment_to_invoice_match', 'business_date'],
      };

  test('a revenue analysis is read, with the customer on each line (a bad id is dropped, never guessed)', () {
    final a = parseAnalysis({
      'analysis': 'revenue', 'version': 1, 'certainty': 'calculated', 'currency': 'ZAR',
      'period': {'from': '2026-10-01', 'to': '2026-10-31'}, 'compare': {'from': '2026-08-31', 'to': '2026-09-30'}, 'basis': {},
      'summary': {'metric': 'total_revenue', 'current': 13500, 'previous': 9000, 'change': {'amount': 4500, 'percent': 50}, 'direction': 'up', 'reconciles': true},
      'contributors': [
        {'name': 'Jenny', 'kind': 'customer', 'customerId': 1, 'current': 8000, 'previous': 5000, 'change': {'amount': 3000, 'percent': 60}, 'shareOfChange': 66.67, 'part': 'driver', 'flags': [], 'evidence': _evidence()},
        {'name': 'Customer 9', 'kind': 'customer', 'customerId': 9, 'current': 500, 'previous': 0, 'change': {'amount': 500}, 'part': 'driver'},
        {'name': 'Zero', 'customerId': 0, 'current': 1, 'previous': 1, 'change': {'amount': 0}},
        {'name': 'Text id', 'customerId': '3', 'current': 1, 'previous': 1, 'change': {'amount': 0}},
      ],
      'findings': [], 'notEstablished': ['cause_of_the_change', 'cash_received'], 'limits': {},
    })!;
    expect(a.topic, 'revenue');
    expect(a.metric, 'total_revenue');
    expect(metricLabel(a.metric), 'Total revenue');
    expect(a.contributors.map((c) => c.customerId), [1, 9, null, null]);
    expect(a.contributors.first.evidence!.reconciled, isTrue);
  });

  test('a customer\'s receivables are read: outstanding invoices, buckets, payments, and what is calculated', () {
    final r = parseReceivables(recv())!;
    expect(r.customerId, 12);
    expect(r.customerName, 'Jenny');
    expect(r.asAt, '2026-10-20');
    expect(r.buckets.total, 2000.5);
    expect(r.buckets.days30, 1500);
    expect(r.paymentsTotal, 1500);
    expect(r.paymentsCount, 1);
    expect(r.invoiceCount, 3);
    expect(r.outstandingCount, 2);
    expect(r.reconciles, isTrue);
    expect(r.truncated, isFalse);
    expect(r.invoices.map((i) => i.description), ['Mid floor', 'New skirting']);
    expect(r.invoices.first.applied, 500);
    expect(r.invoices.first.outstanding, 1500);
    expect(r.invoices.first.ageDays, 45);
    expect(r.invoices.first.bucket, 'days30');
    expect(r.notEstablished, ['payment_to_invoice_match', 'business_date']);
    expect(r.allocationNote, contains('not a record'));
  });

  test('receivables: an unapplied payment and a cut list are carried, and anything unusable is null', () {
    final r = parseReceivables(recv(unapplied: 500, truncated: true))!;
    expect(r.unapplied, 500);
    expect(r.truncated, isTrue);
    for (final b in <Object?>[null, 'x', 5, <Object?>[], <String, Object?>{}, recv(version: 2), {...recv(), 'report': 'aged_debtors'}, {...recv(), 'customer': {'id': 0, 'name': 'x'}}, {...recv(), 'customer': {'id': 'a', 'name': 'x'}}, {...recv(), 'asAt': 'yesterday'}, {...recv(), 'buckets': {'current': 'x'}}, {...recv(), 'payments': 'no'}]) {
      expect(parseReceivables(b), isNull, reason: '$b');
    }
  });

  test('receivables: hostile invoices never throw and are skipped; a missing note gets the plain default', () {
    final r = parseReceivables({...recv(invoices: [null, 5, 'x', {'id': 'a'}, {'id': 1}, {'id': 2, 'date': '2026-10-01', 'amount': 'x', 'outstanding': 1}, {'id': 3, 'date': '2026-10-02', 'description': 5, 'amount': 10, 'outstanding': 10}]), 'basis': 'x', 'notEstablished': [1, null, 'business_date']})!;
    expect(r.invoices.map((i) => i.id), [3]);
    expect(r.invoices.single.description, '');
    expect(r.invoices.single.bucket, 'current');
    expect(r.notEstablished, ['business_date']);
    expect(r.allocationNote, contains('oldest invoices first'));
    final many = [for (var i = 1; i <= 80; i++) {'id': i, 'date': '2026-10-01', 'description': 'x', 'amount': 1, 'outstanding': 1}];
    expect(parseReceivables(recv(invoices: many))!.invoices, hasLength(50));
  });

  test('receivables wording: age buckets in plain words, ages, the non-zero buckets on one line, and what is not matched', () {
    expect(bucketLabel('current'), 'up to 30 days');
    expect(bucketLabel('days30'), '31 to 60 days');
    expect(bucketLabel('days60'), '61 to 90 days');
    expect(bucketLabel('days90Plus'), 'over 90 days');
    expect(bucketLabel('odd'), 'odd');
    expect(ageText(1), '1 day');
    expect(ageText(45), '45 days');
    expect(bucketsLine(const ReceivableBuckets(current: 500.5, days30: 1500, days60: 0, days90Plus: 0, total: 2000.5)), 'up to 30 days R500.50, 31 to 60 days R1,500.00');
    expect(bucketsLine(const ReceivableBuckets(current: 0, days30: 0, days60: 0, days90Plus: 0, total: 0)), '');
    expect(notEstablishedLine('payment_to_invoice_match'), contains('oldest'));
  });
}
