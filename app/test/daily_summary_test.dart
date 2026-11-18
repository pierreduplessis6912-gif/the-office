// The daily summary (lib/engine/daily_summary.dart): when it runs (06:00 South African time = 04:00 UTC), what it says, that it says nothing when nothing needs attention or the answer cannot be read, and the More switch
// (shown only where it can work, asks permission, stays off when the person says no, signing out turns it off). The Android side (WorkManager, the notification itself) is proven by the Android build check in CI,
// not here. Recorded client, no network.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:the_office/engine/assistant_model.dart';
import 'package:the_office/engine/daily_summary.dart';
import 'package:the_office/engine/engine_api.dart';
import 'package:the_office/engine/engine_fixtures.dart';
import 'package:the_office/engine/engine_live_home.dart';

class _AttApi extends FixtureEngineApi {
  final EngineResponse answer;
  final bool throws;
  _AttApi(Map<String, EngineResponse> fixtures, this.answer, {this.throws = false}) : super(fixtures);
  @override
  Future<EngineResponse> attention() async {
    if (throws) throw Exception('offline');
    return answer;
  }
}

EngineResponse _ok(List<Object?> items, int count) => EngineResponse(200, <String, Object?>{'status': 'ok', 'result': <String, Object?>{'items': items, 'count': count, 'truncated': count > items.length}});
Map<String, Object?> _item(String title) => <String, Object?>{'kind': 'job_snag', 'title': title, 'detail': 'x'};

class _FakeSummary implements DailySummary {
  final bool allow;
  final bool canDo;
  bool on = false;
  int turnedOn = 0;
  int turnedOff = 0;
  String? base;
  _FakeSummary({this.allow = true, this.canDo = true});
  @override
  bool get supported => canDo;
  @override
  Future<bool> isOn() async => on;
  @override
  Future<bool> turnOn(String baseUrl) async {
    turnedOn++;
    base = baseUrl;
    on = allow;
    return allow;
  }

  @override
  Future<void> turnOff() async {
    turnedOff++;
    on = false;
  }
}

void main() {
  final fixtures = engineResponsesFrom(engineFixtureJson);

  test('it runs at the next 04:00 UTC, which is 06:00 in South Africa, and never twice on the same day', () {
    expect(delayUntilNextSummary(DateTime.utc(2026, 11, 18, 3, 0)), const Duration(hours: 1));
    expect(delayUntilNextSummary(DateTime.utc(2026, 11, 18, 4, 0)), const Duration(hours: 24), reason: 'exactly at the time means tomorrow');
    expect(delayUntilNextSummary(DateTime.utc(2026, 11, 18, 4, 1)), const Duration(hours: 23, minutes: 59));
    expect(delayUntilNextSummary(DateTime.utc(2026, 11, 18, 23, 30)), const Duration(hours: 4, minutes: 30));
    expect(delayUntilNextSummary(DateTime.utc(2026, 12, 31, 20, 0)), const Duration(hours: 8), reason: 'across the end of the year');
    expect(delayUntilNextSummary(DateTime(2026, 11, 18, 9, 0).toUtc()).inMinutes, inInclusiveRange(1, 24 * 60));
  });

  test('it says how many things need attention and the first three, and how many more', () {
    final one = summaryMessage(parseAttention(200, _ok([_item('Tile Co bill is overdue')], 1).body));
    expect(one!.title, '1 thing needs your attention');
    expect(one.body, 'Tile Co bill is overdue');
    final many = summaryMessage(parseAttention(200, _ok([_item('A'), _item('B'), _item('C'), _item('D')], 7).body));
    expect(many!.title, '7 things need your attention');
    expect(many.body, 'A\nB\nC\n+ 4 more');
    final three = summaryMessage(parseAttention(200, _ok([_item('A'), _item('B'), _item('C')], 3).body));
    expect(three!.body, 'A\nB\nC');
  });

  test('it says nothing when nothing needs attention or the answer cannot be read', () async {
    expect(summaryMessage(null), isNull);
    expect(await dailySummaryMessage(_AttApi(fixtures, _ok(<Object?>[], 0))), isNull);
    expect(await dailySummaryMessage(_AttApi(fixtures, const EngineResponse(401, <String, Object?>{'error': 'no'}))), isNull);
    expect(await dailySummaryMessage(_AttApi(fixtures, const EngineResponse(500, null))), isNull);
    expect(await dailySummaryMessage(_AttApi(fixtures, _ok(<Object?>[], 0), throws: true)), isNull, reason: 'no network posts nothing');
    final said = await dailySummaryMessage(_AttApi(fixtures, _ok([_item('A')], 1)));
    expect(said!.title, '1 thing needs your attention');
  });

  test('the do-nothing summary is not supported and never turns on', () async {
    const none = NoDailySummary();
    expect(none.supported, isFalse);
    expect(await none.turnOn('https://x'), isFalse);
    expect(await none.isOn(), isFalse);
  });

  Widget app(DailySummary summary, {VoidCallback? onSignOut}) => MaterialApp(
        home: EngineLiveHome(baseUrl: 'https://example.test', sessionToken: 'tok', onSignOut: onSignOut ?? () {}, apiFactory: (String b, String t) => FixtureEngineApi(fixtures), dailySummary: summary),
      );

  Future<void> openMore(WidgetTester tester) async {
    await tester.pump(const Duration(milliseconds: 100));
    await tester.tap(find.descendant(of: find.byKey(const Key('live-tabs')), matching: find.text('More')));
    await tester.pump();
    await tester.scrollUntilVisible(find.byKey(const Key('more-daily-summary')), 100, scrollable: find.byType(Scrollable).first);
    await tester.pumpAndSettle();
  }

  testWidgets('the switch turns the summary on with the address, and off again', (tester) async {
    final summary = _FakeSummary();
    await tester.pumpWidget(app(summary));
    await openMore(tester);
    expect(tester.widget<SwitchListTile>(find.byKey(const Key('more-daily-summary'))).value, isFalse);
    await tester.tap(find.byKey(const Key('more-daily-summary')));
    await tester.pumpAndSettle();
    expect(summary.turnedOn, 1);
    expect(summary.base, 'https://example.test');
    expect(tester.widget<SwitchListTile>(find.byKey(const Key('more-daily-summary'))).value, isTrue);
    await tester.tap(find.byKey(const Key('more-daily-summary')));
    await tester.pumpAndSettle();
    expect(summary.turnedOff, 1);
    expect(tester.widget<SwitchListTile>(find.byKey(const Key('more-daily-summary'))).value, isFalse);
  });

  testWidgets('when the person does not allow notifications the switch stays off and says why', (tester) async {
    final summary = _FakeSummary(allow: false);
    await tester.pumpWidget(app(summary));
    await openMore(tester);
    await tester.tap(find.byKey(const Key('more-daily-summary')));
    await tester.pumpAndSettle();
    expect(tester.widget<SwitchListTile>(find.byKey(const Key('more-daily-summary'))).value, isFalse);
    expect(find.textContaining('Notifications are not allowed'), findsOneWidget);
  });

  testWidgets('it starts on when it was already on, and the switch is not shown where it cannot work', (tester) async {
    final on = _FakeSummary()..on = true;
    await tester.pumpWidget(app(on));
    await openMore(tester);
    expect(tester.widget<SwitchListTile>(find.byKey(const Key('more-daily-summary'))).value, isTrue);
    await tester.pumpWidget(const SizedBox());
    await tester.pumpWidget(app(_FakeSummary(canDo: false)));
    await tester.pump(const Duration(milliseconds: 100));
    await tester.tap(find.descendant(of: find.byKey(const Key('live-tabs')), matching: find.text('More')));
    await tester.pump();
    expect(find.byKey(const Key('more-daily-summary')), findsNothing);
  });

  testWidgets('signing out turns the summary off', (tester) async {
    final summary = _FakeSummary()..on = true;
    var out = 0;
    await tester.pumpWidget(app(summary, onSignOut: () => out++));
    await tester.pump(const Duration(milliseconds: 100));
    await tester.tap(find.byKey(const Key('live-sign-out')));
    await tester.pump();
    expect(out, 1);
    expect(summary.turnedOff, 1);
  });
}
