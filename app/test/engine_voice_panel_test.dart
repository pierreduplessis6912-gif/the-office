// The assistant's voice button (lib/engine/assistant_panel.dart + voice_recorder.dart). What this pins: the button exists ONLY when a recorder is given; a first tap starts recording and the button says so; a
// second tap stops, sends the recording to the engine's audio route with a retry key and shows what was HEARD; the engine's own answer (a refusal, a read, a held write) is shown as for a typed sentence; a
// microphone that cannot be used says so and sends nothing; an empty recording sends nothing. No real microphone and no network: a recorded recorder and a recorded client.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:the_office/engine/assistant_panel.dart';
import 'package:the_office/engine/engine_api.dart';
import 'package:the_office/engine/engine_fixtures.dart';
import 'package:the_office/engine/voice_recorder.dart';

class _FakeRecorder implements VoiceRecorder {
  bool allowed;
  VoiceNote? note;
  int starts = 0;
  int stops = 0;
  _FakeRecorder({this.allowed = true, this.note});
  @override
  Future<bool> start() async {
    starts++;
    return allowed;
  }

  @override
  Future<VoiceNote?> stop() async {
    stops++;
    return note;
  }
}

class _AudioApi extends FixtureEngineApi {
  final List<List<int>> sent = <List<int>>[];
  final List<String> keys = <String>[];
  final List<String> filenames = <String>[];
  final EngineResponse answer;
  _AudioApi(Map<String, EngineResponse> fixtures, this.answer) : super(fixtures);
  @override
  Future<EngineResponse> captureAudio(List<int> bytes, {required String idempotencyKey, String filename = 'note.m4a', String contentType = 'audio/m4a'}) async {
    sent.add(bytes);
    keys.add(idempotencyKey);
    filenames.add(filename);
    return answer;
  }
}

Future<void> _open(WidgetTester tester, EngineApi api, {VoiceRecorder? recorder}) async {
  await tester.pumpWidget(MaterialApp(home: Scaffold(body: AssistantPanel(api: api, recorder: recorder))));
  await tester.pump(const Duration(milliseconds: 50));
}

Future<void> _tapVoice(WidgetTester tester) async {
  await tester.tap(find.byKey(const Key('capture-voice')));
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 100));
}

void main() {
  final fixtures = engineResponsesFrom(engineFixtureJson);
  const heard = EngineResponse(422, <String, Object?>{'error': 'not_understood', 'message': 'I did not understand that as something I can do, so nothing was done.', 'transcript': 'Book Sepo for Thursday'});

  testWidgets('there is no voice button unless a recorder is given', (tester) async {
    await _open(tester, _AudioApi(fixtures, heard));
    expect(find.byKey(const Key('capture-voice')), findsNothing);
  });

  testWidgets('tap to record, tap to send: what was heard and the engine\'s answer are shown', (tester) async {
    final api = _AudioApi(fixtures, heard);
    final recorder = _FakeRecorder(note: const VoiceNote(bytes: <int>[1, 2, 3], filename: 'note.m4a', contentType: 'audio/m4a'));
    await _open(tester, api, recorder: recorder);
    expect(find.text('Record a voice note'), findsOneWidget);
    await _tapVoice(tester);
    expect(recorder.starts, 1);
    expect(find.text('Stop and send'), findsOneWidget);
    expect(api.sent, isEmpty);
    await _tapVoice(tester);
    await tester.pump(const Duration(milliseconds: 100));
    expect(recorder.stops, 1);
    expect(api.sent.length, 1);
    expect(api.sent.first, <int>[1, 2, 3]);
    expect(api.keys.first, isNotEmpty);
    expect(api.keys.first.length, lessThanOrEqualTo(100));
    expect(api.filenames.first, 'note.m4a');
    expect(find.textContaining('Book Sepo for Thursday'), findsOneWidget);
    expect(find.textContaining('did not understand'), findsOneWidget);
    expect(find.text('Record a voice note'), findsOneWidget);
  });

  testWidgets('a microphone that cannot be used says so and sends nothing', (tester) async {
    final api = _AudioApi(fixtures, heard);
    final recorder = _FakeRecorder(allowed: false);
    await _open(tester, api, recorder: recorder);
    await _tapVoice(tester);
    expect(find.textContaining('microphone'), findsOneWidget);
    expect(find.text('Record a voice note'), findsOneWidget);
    expect(api.sent, isEmpty);
    expect(recorder.stops, 0);
  });

  testWidgets('an empty recording sends nothing', (tester) async {
    final api = _AudioApi(fixtures, heard);
    final recorder = _FakeRecorder(note: const VoiceNote(bytes: <int>[], filename: 'note.m4a', contentType: 'audio/m4a'));
    await _open(tester, api, recorder: recorder);
    await _tapVoice(tester);
    await _tapVoice(tester);
    await tester.pump(const Duration(milliseconds: 100));
    expect(api.sent, isEmpty);
    expect(find.textContaining('nothing was recorded'), findsOneWidget);
  });
}
