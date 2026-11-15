// The orders room (lib/engine/orders_room.dart) and its parser (parseOrderList). Pinned: each purchase order still waiting for goods shows its supplier, order number, the date ordered, the date expected and the
// total, in the engine's own figures; an empty list and an unreadable one each say so. Read only: an order is raised or received through a held proposal the person approves. Recorded client, no network.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:the_office/engine/assistant_model.dart';
import 'package:the_office/engine/engine_api.dart';
import 'package:the_office/engine/engine_fixtures.dart';
import 'package:the_office/engine/orders_room.dart';

class _OrdersApi extends FixtureEngineApi {
  final EngineResponse answer;
  int reads = 0;
  _OrdersApi(Map<String, EngineResponse> fixtures, this.answer) : super(fixtures);
  @override
  Future<EngineResponse> orders() async {
    reads++;
    return answer;
  }
}

Map<String, Object?> _row(int id, int number, String supplier, String ordered, String? expected, int gross) =>
    <String, Object?>{'id': id, 'number': number, 'supplierName': supplier, 'orderedOn': ordered, 'expectedOn': expected, 'grossMinor': gross, 'status': 'open'};

EngineResponse _ok(List<Object?> rows) => EngineResponse(200, <String, Object?>{'status': 'ok', 'result': <String, Object?>{'orders': rows, 'count': rows.length}});

Future<void> _open(WidgetTester tester, EngineApi api) async {
  await tester.pumpWidget(MaterialApp(home: Scaffold(body: OrdersRoom(key: UniqueKey(), api: api))));
  await tester.pump(const Duration(milliseconds: 100));
  await tester.pump(const Duration(milliseconds: 100));
}

void main() {
  final fixtures = engineResponsesFrom(engineFixtureJson);

  test('the parser keeps the rows it can read and says null for an unreadable answer', () {
    final rows = parseOrderList(200, <String, Object?>{'status': 'ok', 'result': <String, Object?>{'orders': <Object?>[_row(1, 7, 'Timber Supplies', '2026-11-01', '2026-11-10', 115000), <String, Object?>{'id': 2}]}});
    expect(rows!.map((r) => r.id).toList(), <int>[1]);
    expect(rows.first.number, 7);
    expect(parseOrderList(500, <String, Object?>{'error': 'x'}), isNull);
    expect(parseOrderList(200, 'nonsense'), isNull);
    expect(parseOrderList(200, <String, Object?>{'status': 'ok', 'result': <String, Object?>{'orders': <Object?>[]}}), isEmpty);
  });

  testWidgets('each order shows supplier, number, dates and total; a missing expected date is simply not shown', (tester) async {
    await _open(tester, _OrdersApi(fixtures, _ok(<Object?>[_row(1, 7, 'Timber Supplies', '2026-11-01', '2026-11-10', 115000), _row(2, 8, 'Hardware Hub', '2026-11-02', null, 172500)])));
    expect(find.byKey(const Key('order-row-1')), findsOneWidget);
    expect(find.byKey(const Key('order-row-2')), findsOneWidget);
    expect(find.textContaining('Timber Supplies'), findsOneWidget);
    expect(find.textContaining('#7'), findsOneWidget);
    expect(find.textContaining('Ordered 2026-11-01'), findsOneWidget);
    expect(find.text('Expected 2026-11-10'), findsOneWidget);
    expect(find.textContaining('Expected'), findsOneWidget);
    expect(find.text('R1,150.00'), findsOneWidget);
    expect(find.text('R1,725.00'), findsOneWidget);
  });

  testWidgets('an empty list and an unreadable answer each say so, and refresh reads again', (tester) async {
    final empty = _OrdersApi(fixtures, _ok(<Object?>[]));
    await _open(tester, empty);
    expect(find.byKey(const Key('orders-empty')), findsOneWidget);
    await tester.tap(find.byKey(const Key('orders-refresh')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 100));
    expect(empty.reads, 2);
    await _open(tester, _OrdersApi(fixtures, const EngineResponse(500, null)));
    expect(find.byKey(const Key('orders-error')), findsOneWidget);
  });
}
