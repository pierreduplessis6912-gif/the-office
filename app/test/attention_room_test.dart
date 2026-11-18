// The attention room (lib/engine/attention_room.dart): it shows the engine's items in the engine's order with the engine's reason, says plainly when nothing needs attention, when the answer cannot be
// read and when the engine held items back, and it only reads. Recorded client, no network.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:the_office/engine/assistant_model.dart';
import 'package:the_office/engine/attention_room.dart';
import 'package:the_office/engine/engine_api.dart';

class _AApi extends FixtureEngineApi {
  final EngineResponse answer;
  int asked = 0;
  _AApi(this.answer) : super(<String, EngineResponse>{});

  @override
  Future<EngineResponse> attention() async {
    asked++;
    return answer;
  }
}

EngineResponse _ok(Map<String, Object?> result) => EngineResponse(200, <String, Object?>{'status': 'ok', 'result': result});

Future<_AApi> _show(WidgetTester tester, EngineResponse answer) async {
  final api = _AApi(answer);
  await tester.pumpWidget(MaterialApp(home: Scaffold(body: AttentionRoom(api: api))));
  await tester.pumpAndSettle();
  return api;
}

void main() {
  testWidgets('shows each item in the engine order with its reason', (tester) async {
    final api = await _show(tester, _ok(<String, Object?>{
      'items': [
        <String, Object?>{'kind': 'bill_overdue', 'title': "Tile Co's bill is overdue: R575.00", 'detail': 'Bill B-LATE was due 2026-11-10, 7 days ago.', 'amountMinor': 57500},
        <String, Object?>{'kind': 'stock_low', 'title': 'Tile glue is below its reorder level', 'detail': 'Position 0 each against a level of 5.'},
        <String, Object?>{'kind': 'job_snag'},
      ],
      'truncated': false,
    }));
    expect(api.asked, 1);
    expect(find.byKey(const Key('attention-row-0')), findsOneWidget);
    expect(find.byKey(const Key('attention-row-1')), findsOneWidget);
    expect(find.byKey(const Key('attention-row-2')), findsNothing, reason: 'an item without a title is left out');
    expect(find.text("Tile Co's bill is overdue: R575.00"), findsOneWidget);
    expect(find.text('Bill B-LATE was due 2026-11-10, 7 days ago.'), findsOneWidget);
    expect(find.byKey(const Key('attention-truncated')), findsNothing);
  });

  testWidgets('says plainly when nothing needs attention', (tester) async {
    await _show(tester, _ok(<String, Object?>{'items': <Object?>[], 'truncated': false}));
    expect(find.byKey(const Key('attention-empty')), findsOneWidget);
  });

  testWidgets('says plainly when the answer cannot be read, and tries again on request', (tester) async {
    final api = await _show(tester, EngineResponse(500, <String, Object?>{'status': 'error'}));
    expect(find.byKey(const Key('attention-failed')), findsOneWidget);
    await tester.tap(find.byKey(const Key('attention-retry')));
    await tester.pumpAndSettle();
    expect(api.asked, 2);
  });

  testWidgets('says when the engine held items back', (tester) async {
    await _show(tester, _ok(<String, Object?>{
      'items': [<String, Object?>{'kind': 'job_overdue', 'title': 'Mokoena: Lounge floor is overdue', 'detail': 'It was set for 2026-11-10.'}],
      'truncated': true,
    }));
    expect(find.byKey(const Key('attention-truncated')), findsOneWidget);
  });

  test('parseAttention leaves out unreadable rows and refuses an unreadable answer', () {
    expect(parseAttention(500, <String, Object?>{'status': 'ok', 'result': <String, Object?>{'items': <Object?>[]}}), isNull);
    expect(parseAttention(200, <String, Object?>{'status': 'ok', 'result': <String, Object?>{}}), isNull);
    final ok = parseAttention(200, <String, Object?>{'status': 'ok', 'result': <String, Object?>{'items': [<String, Object?>{'kind': 'x', 'title': 'T', 'amountMinor': 5}, 'junk']}});
    expect(ok!.items.length, 1);
    expect(ok.items.first.amountMinor, 5);
    expect(ok.count, 1, reason: 'with no count from the engine it is the rows');
    expect(parseAttention(200, <String, Object?>{'status': 'ok', 'result': <String, Object?>{'items': <Object?>[], 'count': 80, 'truncated': true}})!.count, 80, reason: 'the engine count can be more than the rows it sent');
  });
}
