// THE DAILY SUMMARY: a notification, posted by the phone itself at about 06:00 South African time, saying what needs attention (the engine's own list, GET /engine/attention). No server push and no Firebase: Android's
// WorkManager wakes the app once a day, the app asks the engine, and posts ONE ordinary notification only when something needs attention. This file holds everything that can be proven without a phone (when to run, what
// to say, asking the engine); the part that talks to Android is in daily_summary_android.dart and is a no-op on the web and in tests (daily_summary_platform.dart picks the right one).
import 'assistant_model.dart';
import 'engine_api.dart';

/// 06:00 in South Africa (UTC+2, no daylight saving) is 04:00 UTC.
const int dailySummaryHourUtc = 4;

/// How long from `nowUtc` until the next 04:00 UTC (06:00 in South Africa). Exactly at 04:00 means tomorrow, so a run never repeats itself.
Duration delayUntilNextSummary(DateTime nowUtc) {
  final now = nowUtc.toUtc();
  var next = DateTime.utc(now.year, now.month, now.day, dailySummaryHourUtc);
  if (!next.isAfter(now)) next = next.add(const Duration(days: 1));
  return next.difference(now);
}

class SummaryMessage {
  final String title;
  final String body;
  const SummaryMessage(this.title, this.body);
}

/// What the notification says, or null when there is nothing to say (nothing needs attention, or the answer could not be read: no notification is better than a wrong one).
SummaryMessage? summaryMessage(({List<AttentionEntry> items, bool truncated, int count})? parsed) {
  if (parsed == null || parsed.count <= 0) return null;
  final n = parsed.count;
  final title = n == 1 ? '1 thing needs your attention' : '$n things need your attention';
  final shown = parsed.items.take(3).map((i) => i.title).toList();
  final more = n - shown.length;
  return SummaryMessage(title, [...shown, if (more > 0) '+ $more more'].join('\n'));
}

/// What the TEST notification says: the real list when something needs attention, otherwise a plain line saying which case it is, so the person sees a notification arrive either way.
SummaryMessage testSummaryMessage(({List<AttentionEntry> items, bool truncated, int count})? parsed) {
  if (parsed == null) return const SummaryMessage('Test: the list could not be read', 'Notifications work, but the engine did not answer. Nothing is wrong with the notification.');
  return summaryMessage(parsed) ?? const SummaryMessage('Test: nothing needs your attention', 'Notifications work. This is what a quiet morning looks like (no notification is sent then).');
}

/// Asks the engine and words the answer. Any failure (no network, a refused session, a business that is not on the engine) is null: nothing is posted.
Future<SummaryMessage?> dailySummaryMessage(EngineApi api) async {
  try {
    final response = await api.attention();
    return summaryMessage(parseAttention(response.status, response.body));
  } catch (_) {
    return null;
  }
}

/// Turning the daily summary on and off. The real one lives in daily_summary_android.dart.
abstract class DailySummary {
  /// False where it cannot work (the web, tests, other phones): the switch is not shown.
  bool get supported;
  Future<bool> isOn();

  /// Asks Android's permission to post notifications, then schedules the daily run. False when the person said no (nothing is scheduled).
  Future<bool> turnOn(String baseUrl);
  Future<void> turnOff();

  /// Posts a notification right now (for the test button). False when Android does not allow notifications.
  Future<bool> showNow(SummaryMessage message);
}

class NoDailySummary implements DailySummary {
  const NoDailySummary();
  @override
  bool get supported => false;
  @override
  Future<bool> isOn() async => false;
  @override
  Future<bool> turnOn(String baseUrl) async => false;
  @override
  Future<void> turnOff() async {}
  @override
  Future<bool> showNow(SummaryMessage message) async => false;
}
