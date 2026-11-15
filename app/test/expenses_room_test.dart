// The expenses room (lib/engine/expenses_room.dart) and its parser (parseExpenseList in assistant_model.dart). What this pins: every expense the engine lists is shown with its supplier, category, date and total in
// the engine's own figures, and whether the VAT on it can be claimed; an empty list and a list that cannot be read each say so; nothing is computed or edited here (an expense is recorded or voided only through a
// held proposal the person approves in the assistant). Recorded client, no network.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:the_office/engine/assistant_model.dart';
import 'package:the_office/engine/engine_api.dart';
import 'package:the_office/engine/engine_fixtures.dart';
import 'package:the_office/engine/expenses_room.dart';

class _ExpensesApi extends FixtureEngineApi {
  final EngineResponse answer;
  int reads = 0;
  _ExpensesApi(Map<String, EngineResponse> fixtures, this.answer) : super(fixtures);
  @override
  Future<EngineResponse> expenses() async {
    reads++;
    return answer;
  }
}

Map<String, Object?> _row(int id, String supplier, String category, String date, int gross, bool claimable) =>
    <String, Object?>{'id': id, 'supplierName': supplier, 'category': category, 'incurredOn': date, 'grossMinor': gross, 'inputTaxClaimable': claimable};

EngineResponse _ok(List<Object?> rows) => EngineResponse(200, <String, Object?>{'status': 'ok', 'result': <String, Object?>{'expenses': rows, 'count': rows.length}});

Future<void> _open(WidgetTester tester, EngineApi api) async {
  await tester.pumpWidget(MaterialApp(home: Scaffold(body: ExpensesRoom(api: api))));
  await tester.pump(const Duration(milliseconds: 100));
  await tester.pump(const Duration(milliseconds: 100));
}

void main() {
  final fixtures = engineResponsesFrom(engineFixtureJson);

  test('the parser reads the rows the engine gave and leaves out one it cannot read', () {
    final rows = parseExpenseList(200, <String, Object?>{
      'status': 'ok',
      'result': <String, Object?>{
        'expenses': <Object?>[_row(1, 'Timber Supplies', 'materials', '2026-11-06', 23000, true), <String, Object?>{'id': 2}, _row(3, 'Shell', 'fuel', '2026-11-07', 50000, false)],
      },
    });
    expect(rows, isNotNull);
    expect(rows!.map((e) => e.id).toList(), <int>[1, 3]);
    expect(rows.first.supplier, 'Timber Supplies');
    expect(rows.first.claimable, isTrue);
    expect(parseExpenseList(500, <String, Object?>{'error': 'x'}), isNull);
    expect(parseExpenseList(200, 'nonsense'), isNull);
    expect(parseExpenseList(200, <String, Object?>{'status': 'ok', 'result': <String, Object?>{'expenses': <Object?>[]}}), isEmpty);
  });

  testWidgets('each expense is shown with its supplier, category, date, total and whether the VAT is claimable', (tester) async {
    await _open(tester, _ExpensesApi(fixtures, _ok(<Object?>[_row(1, 'Timber Supplies', 'materials', '2026-11-06', 23000, true), _row(3, 'Shell', 'fuel', '2026-11-07', 50000, false)])));
    expect(find.byKey(const Key('expense-row-1')), findsOneWidget);
    expect(find.byKey(const Key('expense-row-3')), findsOneWidget);
    expect(find.textContaining('Timber Supplies'), findsOneWidget);
    expect(find.textContaining('materials'), findsOneWidget);
    expect(find.textContaining('2026-11-06'), findsOneWidget);
    expect(find.textContaining('230'), findsOneWidget);
    expect(find.text('VAT claimable'), findsOneWidget);
    expect(find.text('VAT not claimable'), findsOneWidget);
  });

  testWidgets('an empty list says so', (tester) async {
    await _open(tester, _ExpensesApi(fixtures, _ok(<Object?>[])));
    expect(find.byKey(const Key('expenses-empty')), findsOneWidget);
  });

  testWidgets('a list that cannot be read says so, and Check again reads it once more', (tester) async {
    final api = _ExpensesApi(fixtures, const EngineResponse(500, <String, Object?>{'error': 'x'}));
    await _open(tester, api);
    expect(find.byKey(const Key('expenses-error')), findsOneWidget);
    expect(api.reads, 1);
    await tester.tap(find.byKey(const Key('expenses-refresh')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 100));
    expect(api.reads, 2);
  });
}
