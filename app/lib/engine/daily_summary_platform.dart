// Picks the daily summary for where the app is running: the Android one wherever dart:io exists (and only acts on an Android phone), a do-nothing one on the web, so the web build never sees the Android plugins.
export 'daily_summary_stub.dart' if (dart.library.io) 'daily_summary_android.dart';
