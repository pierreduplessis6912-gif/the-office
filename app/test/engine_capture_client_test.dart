// The app's side of the approved connection (docs/decisions/app-connection.md and engine-capture.md): reading the business's mode from /auth/me, and sending a voice note to the engine. Against recorded HTTP (MockClient), never a network.
// What it pins: the engine shell opens ONLY when the server says "engine" (an older server, a signed-out answer or junk never opens it); a voice note goes as a multipart form to /engine/capture/audio with the file as audio, a retry key,
// and the token in a header only; nothing is sent for an empty recording or a bad key; every status and body passes through unchanged (a 503 stays a 503); the recorded demo says voice is not part of it.
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:the_office/engine/engine_api.dart';
import 'package:the_office/engine/engine_mode.dart';
import 'package:the_office/engine/http_engine_api.dart';

const String _token = 'test-session-token';

http.Response _json(int status, Object? body) => http.Response(jsonEncode(body), status, headers: const <String, String>{'content-type': 'application/json'});

void main() {
  group('business mode from /auth/me', () {
    test('engine only when signed in and the server says engine', () {
      expect(businessModeFrom(<String, Object?>{'signedIn': true, 'email': 'a@b.c', 'role': 'owner', 'mode': 'engine'}), BusinessMode.engine);
      expect(showsEngineShell(businessModeFrom(<String, Object?>{'signedIn': true, 'mode': 'engine'})), isTrue);
    });
    test('legacy when the server says legacy', () {
      expect(businessModeFrom(<String, Object?>{'signedIn': true, 'mode': 'legacy'}), BusinessMode.legacy);
      expect(showsEngineShell(BusinessMode.legacy), isFalse);
    });
    test('an older server (no mode), a signed-out answer, an odd mode or junk never opens the engine shell', () {
      for (final Object? body in <Object?>[
        <String, Object?>{'signedIn': true, 'email': 'a@b.c', 'role': 'owner'},
        <String, Object?>{'signedIn': false, 'mode': 'engine'},
        <String, Object?>{'signedIn': true, 'mode': 'Engine'},
        <String, Object?>{'signedIn': true, 'mode': 1},
        <String, Object?>{'signedIn': 'true', 'mode': 'engine'},
        'engine',
        null,
        <Object?>[],
      ]) {
        expect(showsEngineShell(businessModeFrom(body)), isFalse, reason: '$body');
      }
    });
  });

  group('voice note to the engine', () {
    HttpEngineApi api(MockClientHandler handler) => HttpEngineApi(baseUrl: 'https://office.example.test', sessionToken: _token, client: MockClient(handler));

    test('a multipart form to /engine/capture/audio: the file as audio, the retry key, the token in a header only', () async {
      late http.Request seen;
      final result = await api((r) async {
        seen = r;
        return _json(200, <String, Object?>{'status': 'ok', 'transcript': 'What does Mokoena owe me?', 'captureId': 3});
      }).captureAudio(utf8.encode('fake audio bytes'), idempotencyKey: 'note-123');
      expect(seen.method, 'POST');
      expect(seen.url.path, '/engine/capture/audio');
      expect(seen.headers['Authorization'], 'Bearer $_token');
      expect(seen.headers['content-type'], startsWith('multipart/form-data'));
      expect(seen.url.toString().contains(_token), isFalse);
      expect(seen.body.contains(_token), isFalse);
      expect(seen.body, contains('name="audio"'));
      expect(seen.body, contains('filename="note.m4a"'));
      expect(seen.body.toLowerCase(), contains('content-type: audio/m4a'));
      expect(seen.body, contains('fake audio bytes'));
      expect(seen.body, contains('name="idempotency_key"'));
      expect(seen.body, contains('note-123'));
      expect(result.status, 200);
      expect((result.body as Map)['transcript'], 'What does Mokoena owe me?');
    });

    test('an empty recording or a bad retry key never reaches the network', () async {
      var calls = 0;
      final client = api((r) async {
        calls++;
        return _json(200, <String, Object?>{});
      });
      expect((await client.captureAudio(<int>[], idempotencyKey: 'k')).status, 422);
      expect((await client.captureAudio(<int>[1], idempotencyKey: '')).status, 422);
      expect((await client.captureAudio(<int>[1], idempotencyKey: 'x' * 101)).status, 422);
      expect(calls, 0);
    });

    test('every status and body passes through unchanged: held, not understood, model down, too large', () async {
      for (final entry in <int, Map<String, Object?>>{
        200: <String, Object?>{'status': 'held', 'actionId': 7},
        422: <String, Object?>{'error': 'not_understood'},
        503: <String, Object?>{'error': 'model_unavailable'},
        413: <String, Object?>{'error': 'too_large'},
      }.entries) {
        final result = await api((r) async => _json(entry.key, entry.value)).captureAudio(<int>[1, 2, 3], idempotencyKey: 'k${entry.key}');
        expect(result.status, entry.key);
        expect(result.body, entry.value);
      }
    });

    test('a body that is not JSON becomes null, not an error', () async {
      final result = await api((r) async => http.Response('<html>', 502)).captureAudio(<int>[1], idempotencyKey: 'k');
      expect(result.status, 502);
      expect(result.body, isNull);
    });

    test('the recorded demo says voice is not part of it', () async {
      final demo = FixtureEngineApi(<String, EngineResponse>{});
      final result = await demo.captureAudio(<int>[1], idempotencyKey: 'k');
      expect(result.status, 501);
    });
  });
}
