// The quotations room (lib/engine/quotes_room.dart) and its parser (parseQuoteList). Pinned: each quotation that is not superseded shows its customer, number, issue date, the date it is valid until, its status
// (open or accepted) and the total, in the engine's own figures; an empty list and an unreadable one each say so. Read only: a quotation is made, accepted or changed through a held proposal the person approves.
// Recorded client, no network.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:the_office/engine/assistant_model.dart';
import 'package:the_office/engine/engine_api.dart';
import 'package:the_office/engine/engine_fixtures.dart';
import 'package:the_office/engine/quotes_room.dart';

class _QuotesApi extends FixtureEngineApi {
  final EngineResponse answer;
  int reads = 0;
  _QuotesApi(Map<String, EngineResponse> fixtures, this.answer) : super(fixtures);
  @override
  Future<EngineResponse> quotations() async {
    reads++;
    return answer;
  }
}

Map<String, Object?> _row(int id, int number, String party, String issued, String? until, int gross, String status) =>
    <String, Object?>{'id': id, 'number': number, 'partyName': party, 'issuedOn': issued, 'validUntil': until, 'grossMinor': gross, 'status': status};

EngineResponse _ok(List<Object?> rows) => EngineResponse(200, <String, Object?>{'status': 'ok', 'result': <String, Object?>{'quotations': rows, 'count': rows.length}});

Future<void> _open(WidgetTester tester, EngineApi api) async {
  await tester.pumpWidget(MaterialApp(home: Scaffold(body: QuotesRoom(key: UniqueKey(), api: api))));
  await tester.pump(const Duration(milliseconds: 100));
  await tester.pump(const Duration(milliseconds: 100));
}

void main() {
  final fixtures = engineResponsesFrom(engineFixtureJson);

  test('the parser keeps the rows it can read and says null for an unreadable answer', () {
    final rows = parseQuoteList(200, <String, Object?>{'status': 'ok', 'result': <String, Object?>{'quotations': <Object?>[_row(1, 4, 'Mokoena', '2026-11-01', '2026-11-30', 230000, 'open'), <String, Object?>{'id': 2}]}});
    expect(rows!.map((r) => r.id).toList(), <int>[1]);
    expect(rows.first.status, 'open');
    expect(parseQuoteList(500, <String, Object?>{'error': 'x'}), isNull);
    expect(parseQuoteList(200, 'nonsense'), isNull);
    expect(parseQuoteList(200, <String, Object?>{'status': 'ok', 'result': <String, Object?>{'quotations': <Object?>[]}}), isEmpty);
  });

  testWidgets('each quotation shows customer, number, dates, status and total; a missing valid-until date is not shown', (tester) async {
    await _open(tester, _QuotesApi(fixtures, _ok(<Object?>[_row(1, 4, 'Mokoena', '2026-11-01', '2026-11-30', 230000, 'open'), _row(2, 5, 'Naidoo', '2026-11-03', null, 50000, 'accepted')])));
    expect(find.byKey(const Key('quote-row-1')), findsOneWidget);
    expect(find.byKey(const Key('quote-row-2')), findsOneWidget);
    expect(find.textContaining('Mokoena'), findsOneWidget);
    expect(find.textContaining('#4'), findsOneWidget);
    expect(find.textContaining('Issued 2026-11-01'), findsOneWidget);
    expect(find.text('Valid until 2026-11-30'), findsOneWidget);
    expect(find.textContaining('Valid until'), findsOneWidget);
    expect(find.text('Open'), findsOneWidget);
    expect(find.text('Accepted'), findsOneWidget);
    expect(find.text('R2,300.00'), findsOneWidget);
    expect(find.text('R500.00'), findsOneWidget);
  });

  testWidgets('an empty list and an unreadable answer each say so, and refresh reads again', (tester) async {
    final empty = _QuotesApi(fixtures, _ok(<Object?>[]));
    await _open(tester, empty);
    expect(find.byKey(const Key('quotes-empty')), findsOneWidget);
    await tester.tap(find.byKey(const Key('quotes-refresh')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 100));
    expect(empty.reads, 2);
    await _open(tester, _QuotesApi(fixtures, const EngineResponse(500, null)));
    expect(find.byKey(const Key('quotes-error')), findsOneWidget);
  });
}
