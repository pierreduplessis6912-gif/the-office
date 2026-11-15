// The stock room (lib/engine/stock_room.dart) and its parser (parseStockList in assistant_model.dart). Pinned: each item shows its name, how much there is and what is already promised, in the engine's own
// figures; an item below its reorder level says so; the value shows only when the engine sent one; an empty list and an unreadable one each say so. Read only. Recorded client, no network.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:the_office/engine/assistant_model.dart';
import 'package:the_office/engine/engine_api.dart';
import 'package:the_office/engine/engine_fixtures.dart';
import 'package:the_office/engine/stock_room.dart';

class _StockApi extends FixtureEngineApi {
  final EngineResponse answer;
  int reads = 0;
  _StockApi(Map<String, EngineResponse> fixtures, this.answer) : super(fixtures);
  @override
  Future<EngineResponse> stock() async {
    reads++;
    return answer;
  }
}

Map<String, Object?> _row(int id, String name, int q, {int reserved = 0, bool below = false, int? value}) =>
    <String, Object?>{'itemId': id, 'name': name, 'unit': 'sheet', 'quantityMilli': q, 'reservedMilli': reserved, 'availableMilli': q - reserved, 'belowReorder': below, 'valueMinor': value};

EngineResponse _ok(List<Object?> rows) => EngineResponse(200, <String, Object?>{'status': 'ok', 'result': <String, Object?>{'stock': rows}});

Future<void> _open(WidgetTester tester, EngineApi api) async {
  await tester.pumpWidget(MaterialApp(home: Scaffold(body: StockRoom(api: api))));
  await tester.pump(const Duration(milliseconds: 100));
  await tester.pump(const Duration(milliseconds: 100));
}

void main() {
  final fixtures = engineResponsesFrom(engineFixtureJson);

  test('quantities in thousandths read as plain numbers', () {
    expect(quantityFromMilli(12000), '12');
    expect(quantityFromMilli(2500), '2.5');
    expect(quantityFromMilli(0), '0');
    expect(quantityFromMilli(-500), '-0.5');
    expect(quantityFromMilli(-2250), '-2.25');
  });

  test('the parser keeps the rows it can read and says null for an unreadable answer', () {
    final rows = parseStockList(200, <String, Object?>{'status': 'ok', 'result': <String, Object?>{'stock': <Object?>[_row(1, 'Plywood 18mm', 40000, reserved: 5000, value: 900000), <String, Object?>{'itemId': 2}]}});
    expect(rows!.map((r) => r.id).toList(), <int>[1]);
    expect(rows.first.valueMinor, 900000);
    expect(rows.first.availableMilli, 35000);
    expect(parseStockList(500, <String, Object?>{'error': 'x'}), isNull);
    expect(parseStockList(200, 'nonsense'), isNull);
    expect(parseStockList(200, <String, Object?>{'status': 'ok', 'result': <String, Object?>{'stock': <Object?>[]}}), isEmpty);
  });

  testWidgets('each item shows what there is, what is promised, and a low-stock note', (tester) async {
    await _open(tester, _StockApi(fixtures, _ok(<Object?>[_row(1, 'Plywood 18mm', 40000, reserved: 5000, value: 900000), _row(2, 'Screws 50mm', 3000, below: true)])));
    expect(find.byKey(const Key('stock-row-1')), findsOneWidget);
    expect(find.textContaining('Plywood 18mm'), findsOneWidget);
    expect(find.textContaining('40 sheet'), findsOneWidget);
    expect(find.textContaining('5 promised'), findsOneWidget);
    expect(find.textContaining('9000'), findsOneWidget);
    expect(find.text('Below reorder level'), findsOneWidget);
  });

  testWidgets('no value is shown when the engine sent none', (tester) async {
    await _open(tester, _StockApi(fixtures, _ok(<Object?>[_row(1, 'Plywood 18mm', 40000)])));
    expect(find.textContaining('Value'), findsNothing);
  });

  testWidgets('an empty list and an unreadable answer each say so, and refresh reads again', (tester) async {
    final empty = _StockApi(fixtures, _ok(<Object?>[]));
    await _open(tester, empty);
    expect(find.byKey(const Key('stock-empty')), findsOneWidget);
    await tester.tap(find.byKey(const Key('stock-refresh')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 100));
    expect(empty.reads, 2);
    await _open(tester, _StockApi(fixtures, const EngineResponse(500, null)));
    expect(find.byKey(const Key('stock-error')), findsOneWidget);
  });
}
