// The app's side of photo and document capture (docs/decisions/engine-capture-image.md, -receipt.md, -bill.md): the client sends a multipart form to /engine/capture/photo or /document with the intent the PERSON chose (a receipt, a
// supplier bill, or none), the token in a header only; nothing useless reaches the network; a kept-but-not-acted-on answer is shown plainly; the assistant's buttons exist only when a picker is given, and each button sends the
// intent it says. Against recorded and scripted answers only.
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:the_office/engine/assistant_model.dart';
import 'package:the_office/engine/assistant_panel.dart';
import 'package:the_office/engine/engine_api.dart';
import 'package:the_office/engine/http_engine_api.dart';

const String _token = 'test-session-token';

http.Response _json(int status, Object? body) => http.Response(jsonEncode(body), status, headers: const <String, String>{'content-type': 'application/json'});

class _Spy extends FixtureEngineApi {
  final List<Map<String, Object?>> sent = <Map<String, Object?>>[];
  final EngineResponse answer;
  _Spy(this.answer) : super(<String, EngineResponse>{});

  @override
  Future<EngineResponse> captureImage(List<int> bytes, {required String kind, required String idempotencyKey, String? intent, String? caption, String filename = 'photo.jpg', String contentType = 'image/jpeg'}) async {
    sent.add(<String, Object?>{'kind': kind, 'intent': intent, 'key': idempotencyKey, 'length': bytes.length});
    return answer;
  }
}

void main() {
  HttpEngineApi api(MockClientHandler handler) => HttpEngineApi(baseUrl: 'https://office.example.test', sessionToken: _token, client: MockClient(handler));

  group('photo and document to the engine', () {
    test('a multipart form to /engine/capture/photo with the intent, the caption and the retry key; the token in a header only', () async {
      late http.Request seen;
      final result = await api((r) async {
        seen = r;
        return _json(200, <String, Object?>{'status': 'held', 'actionId': 7});
      }).captureImage(utf8.encode('fake image bytes'), kind: 'photo', idempotencyKey: 'photo-1', intent: 'supplier_bill', caption: ' for the Dlamini job ');
      expect(seen.method, 'POST');
      expect(seen.url.path, '/engine/capture/photo');
      expect(seen.headers['Authorization'], 'Bearer $_token');
      expect(seen.headers['content-type'], startsWith('multipart/form-data'));
      expect(seen.url.toString().contains(_token), isFalse);
      expect(seen.body.contains(_token), isFalse);
      expect(seen.body, contains('name="photo"'));
      expect(seen.body.toLowerCase(), contains('content-type: image/jpeg'));
      expect(seen.body, contains('fake image bytes'));
      expect(seen.body, contains('name="idempotency_key"'));
      expect(seen.body, contains('photo-1'));
      expect(seen.body, contains('name="intent"'));
      expect(seen.body, contains('supplier_bill'));
      expect(seen.body, contains('name="caption"'));
      expect(seen.body, contains('for the Dlamini job'));
      expect(result.status, 200);
    });

    test('a document goes to /engine/capture/document under the field "document"; no intent and no caption means neither is sent', () async {
      late http.Request seen;
      await api((r) async {
        seen = r;
        return _json(200, <String, Object?>{'status': 'captured'});
      }).captureImage(<int>[1, 2, 3], kind: 'document', idempotencyKey: 'doc-1', filename: 'b.png', contentType: 'image/png');
      expect(seen.url.path, '/engine/capture/document');
      expect(seen.body, contains('name="document"'));
      expect(seen.body, isNot(contains('name="intent"')));
      expect(seen.body, isNot(contains('name="caption"')));
    });

    test('an unknown kind, an intent that is not offered, an empty file or a bad retry key never reaches the network', () async {
      var calls = 0;
      final client = api((r) async {
        calls++;
        return _json(200, <String, Object?>{});
      });
      expect((await client.captureImage(<int>[1], kind: 'video', idempotencyKey: 'k')).status, 422);
      expect((await client.captureImage(<int>[1], kind: 'photo', idempotencyKey: 'k', intent: 'payment')).status, 422);
      expect((await client.captureImage(<int>[], kind: 'photo', idempotencyKey: 'k')).status, 422);
      expect((await client.captureImage(<int>[1], kind: 'photo', idempotencyKey: '')).status, 422);
      expect((await client.captureImage(<int>[1], kind: 'photo', idempotencyKey: 'x' * 101)).status, 422);
      expect(calls, 0);
    });

    test('every status and body passes through unchanged (a 503 stays a 503)', () async {
      final result = await api((r) async => _json(503, <String, Object?>{'error': 'model_unavailable'})).captureImage(<int>[1], kind: 'photo', idempotencyKey: 'k', intent: 'expense');
      expect(result.status, 503);
      expect((result.body as Map)['error'], 'model_unavailable');
    });

    test('the recorded demo says photos are not part of it', () async {
      expect((await FixtureEngineApi(<String, EngineResponse>{}).captureImage(<int>[1], kind: 'photo', idempotencyKey: 'k')).status, 501);
    });
  });

  group('what the person is shown', () {
    test('a photo that was only kept and read says so plainly and is not a held action', () {
      final turn = parseInterpret(200, <String, Object?>{'status': 'captured', 'message': 'Your photo was saved and read. Nothing was done with it.'});
      expect(turn.kind, AssistantKind.captured);
      expect(turn.message, contains('Nothing was done'));
    });
    test('a held bill is held, with its own title', () {
      expect(parseInterpret(200, <String, Object?>{'status': 'held', 'actionId': 7, 'understood': <String, Object?>{'capability': 'supplier_invoice.record'}}).kind, AssistantKind.held);
      expect(heldTitle('engine.supplier_invoice.record'), 'Record a supplier bill');
    });
  });

  group('the assistant\'s capture buttons', () {
    Future<void> open(WidgetTester tester, EngineApi api, {Future<EngineCaptureFile?> Function()? pick}) async {
      await tester.pumpWidget(MaterialApp(home: Scaffold(body: AssistantPanel(api: api, pickPhoto: pick))));
      await tester.pump(const Duration(milliseconds: 50));
    }

    Future<EngineCaptureFile?> pickOne() async => const EngineCaptureFile(bytes: <int>[1, 2, 3]);

    testWidgets('with no picker (the recorded demo) there are no capture buttons', (tester) async {
      await open(tester, _Spy(const EngineResponse(200, <String, Object?>{})));
      expect(find.byKey(const Key('capture-photo')), findsNothing);
      expect(find.byKey(const Key('capture-receipt')), findsNothing);
      expect(find.byKey(const Key('capture-bill')), findsNothing);
    });

    testWidgets('each button sends the intent it says, and a kept photo is shown as kept', (tester) async {
      final spy = _Spy(const EngineResponse(200, <String, Object?>{'status': 'captured', 'message': 'Saved. Nothing was done with it.'}));
      await open(tester, spy, pick: pickOne);
      for (final key in <String>['capture-photo', 'capture-receipt', 'capture-bill']) {
        await tester.tap(find.byKey(Key(key)));
        await tester.pump();
        await tester.pump(const Duration(milliseconds: 100));
      }
      expect(spy.sent.map((m) => m['intent']).toList(), <Object?>[null, 'expense', 'supplier_bill']);
      expect(spy.sent.every((m) => m['kind'] == 'photo' && m['length'] == 3), isTrue);
      expect(spy.sent.map((m) => m['key']).toSet().length, 3);
      expect(find.byKey(const Key('captured-line')), findsWidgets);
    });

    testWidgets('cancelling the picker sends nothing', (tester) async {
      final spy = _Spy(const EngineResponse(200, <String, Object?>{}));
      await open(tester, spy, pick: () async => null);
      await tester.tap(find.byKey(const Key('capture-receipt')));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 100));
      expect(spy.sent, isEmpty);
    });
  });
}
