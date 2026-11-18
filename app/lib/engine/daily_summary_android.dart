// The Android part of the daily summary (see daily_summary.dart): WorkManager runs once a day, reads the person's saved session and the address, asks the engine what needs attention and posts one notification.
// Proven by the Android build check in CI (it must compile and package); what Android does with the schedule on a real phone (the exact minute, battery saving) is not something a test can prove.
import 'dart:io' show Platform;

import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:flutter_local_notifications/flutter_local_notifications.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:workmanager/workmanager.dart';

import 'daily_summary.dart';
import 'http_engine_api.dart';

const _task = 'daily-summary';
const _flagKey = 'daily_summary_on';
const _baseKey = 'daily_summary_base';
const _tokenKey = 'session_token';
const _channelId = 'daily_summary';

final FlutterLocalNotificationsPlugin _notes = FlutterLocalNotificationsPlugin();

Future<void> _initNotes() => _notes.initialize(const InitializationSettings(android: AndroidInitializationSettings('@mipmap/ic_launcher')));

Future<void> _post(SummaryMessage message) async {
  await _initNotes();
  await _notes.show(
    1,
    message.title,
    message.body,
    NotificationDetails(
      android: AndroidNotificationDetails(_channelId, 'Daily summary', channelDescription: 'What needs your attention, once a day', importance: Importance.defaultImportance, priority: Priority.defaultPriority, styleInformation: BigTextStyleInformation(message.body)),
    ),
  );
}

/// The background entry point WorkManager starts once a day, in its own isolate: no screen, only the saved session and the address.
@pragma('vm:entry-point')
void dailySummaryDispatcher() {
  Workmanager().executeTask((task, inputData) async {
    const storage = FlutterSecureStorage();
    final token = await storage.read(key: _tokenKey);
    final base = await storage.read(key: _baseKey);
    if (token == null || base == null) return true;
    final message = await dailySummaryMessage(HttpEngineApi(baseUrl: base, sessionToken: token));
    if (message == null) return true;
    await _post(message);
    return true;
  });
}

class AndroidDailySummary implements DailySummary {
  const AndroidDailySummary();
  static const _storage = FlutterSecureStorage();

  @override
  bool get supported => true;

  @override
  Future<bool> isOn() async => (await _storage.read(key: _flagKey)) == '1';

  @override
  Future<bool> turnOn(String baseUrl) async {
    await _initNotes();
    final android = _notes.resolvePlatformSpecificImplementation<AndroidFlutterLocalNotificationsPlugin>();
    final allowed = await android?.requestNotificationsPermission();
    if (allowed != true) return false;
    await _storage.write(key: _baseKey, value: baseUrl);
    await Workmanager().initialize(dailySummaryDispatcher);
    await Workmanager().registerPeriodicTask(
      _task,
      _task,
      frequency: const Duration(hours: 24),
      initialDelay: delayUntilNextSummary(DateTime.now().toUtc()),
      constraints: Constraints(networkType: NetworkType.connected),
      existingWorkPolicy: ExistingPeriodicWorkPolicy.update,
    );
    await _storage.write(key: _flagKey, value: '1');
    return true;
  }

  @override
  Future<bool> showNow(SummaryMessage message) async {
    await _initNotes();
    final android = _notes.resolvePlatformSpecificImplementation<AndroidFlutterLocalNotificationsPlugin>();
    if (await android?.areNotificationsEnabled() != true && await android?.requestNotificationsPermission() != true) return false;
    await _post(message);
    return true;
  }

  @override
  Future<void> turnOff() async {
    await Workmanager().cancelByUniqueName(_task);
    await _storage.delete(key: _flagKey);
  }
}

DailySummary createDailySummary() => !kIsWeb && Platform.isAndroid ? const AndroidDailySummary() : const NoDailySummary();
