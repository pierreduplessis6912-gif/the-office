// lib/engine/http_engine_api.dart, the real client for the engine's routes. It runs here against a recorded HTTP exchange (MockClient), never a network. What this pins: it calls exactly the routes the backend slice test walks, with the bearer token in a
// header and never in a URL; it carries every status and body through unchanged (a 403 stays a 403); a body that is not JSON becomes null rather than an error; it refuses an address that is not https (a local one is allowed for development) and
// an empty token; it never asks for a record kind that is not a plain word; and the engine shell runs on it exactly as it runs on the fixtures.
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:the_office/engine/engine_api.dart';
import 'package:the_office/engine/engine_shell.dart';
import 'package:the_office/engine/http_engine_api.dart';

const String _token = 'test-session-token';
late Map<String, EngineResponse> _fx;

http.Response _json(int status, Object? body) => http.Response(jsonEncode(body), status, headers: const <String, String>{'content-type': 'application/json'});

void main() {
  setUpAll(() {
    _fx = <String, EngineResponse>{};
    for (final f in Directory('test/fixtures/slice').listSync().whereType<File>()) {
      if (!f.path.endsWith('.json')) continue;
      final parsed = EngineResponse.fromFixtureJson(f.readAsStringSync());
      if (parsed != null) _fx[f.uri.pathSegments.last.replaceAll('.json', '')] = parsed;
    }
  });

  HttpEngineApi api(MockClientHandler handler) => HttpEngineApi(baseUrl: 'https://office.example.test', sessionToken: _token, client: MockClient(handler));

  test('receivables: GET the engine route with the name in the query and the token in a header only', () async {
    late http.Request seen;
    final result = await api((r) async {
      seen = r;
      return _json(200, <String, Object?>{'status': 'ok'});
    }).receivables('Patel Builders & Sons');
    expect(seen.method, 'GET');
    expect(seen.url.path, '/engine/receivables');
    expect(seen.url.queryParameters['party'], 'Patel Builders & Sons');
    expect(seen.headers['Authorization'], 'Bearer $_token');
    expect(seen.url.toString().contains(_token), isFalse);
    expect(result.status, 200);
  });

  test('record: GET /engine/records/<kind>/<id>', () async {
    late http.Request seen;
    await api((r) async {
      seen = r;
      return _json(200, <String, Object?>{});
    }).record('document', 1);
    expect(seen.method, 'GET');
    expect(seen.url.path, '/engine/records/document/1');
  });

  test('a record kind that is not a plain word, or a number below one, never reaches the network', () async {
    var calls = 0;
    final client = api((r) async {
      calls++;
      return _json(200, <String, Object?>{});
    });
    expect((await client.record('../admin', 1)).status, 404);
    expect((await client.record('document/1?x', 1)).status, 404);
    expect((await client.record('document', 0)).status, 404);
    expect(calls, 0);
  });

  test('proposePayment: POST the capability, the payload, what was said and where it came from', () async {
    late http.Request seen;
    await api((r) async {
      seen = r;
      return _json(200, <String, Object?>{'status': 'held', 'actionId': 1});
    }).proposePayment(<String, Object?>{'partyId': 1, 'amountMinor': 50000, 'currency': 'ZAR', 'occurredOn': '2026-11-07', 'allocate': 'oldest_first'}, 'Record R500 from Mokoena');
    expect(seen.method, 'POST');
    expect(seen.url.path, '/engine/proposals');
    expect(seen.headers['Content-Type'], contains('application/json'));
    expect(seen.headers['Authorization'], 'Bearer $_token');
    expect(jsonDecode(seen.body), <String, Object?>{
      'capability': 'payment.record',
      'payload': <String, Object?>{'partyId': 1, 'amountMinor': 50000, 'currency': 'ZAR', 'occurredOn': '2026-11-07', 'allocate': 'oldest_first'},
      'transcript': 'Record R500 from Mokoena',
      'source': 'app',
    });
  });

  test('pending and confirm use the held-action routes', () async {
    final seen = <http.Request>[];
    final client = api((r) async {
      seen.add(r);
      return _json(200, <String, Object?>{});
    });
    await client.pending();
    await client.confirm(7);
    await client.reject(7);
    expect(seen[0].method, 'GET');
    expect(seen[0].url.path, '/actions/pending');
    expect(seen[1].method, 'POST');
    expect(seen[1].url.path, '/actions/7/confirm');
    expect(jsonDecode(seen[1].body), <String, Object?>{});
    expect(seen[2].method, 'POST');
    expect(seen[2].url.path, '/actions/7/reject');
    expect(jsonDecode(seen[2].body), <String, Object?>{});
  });

  test('every status and body is carried through, and a body that is not JSON becomes null', () async {
    final refused = await api((r) async => _json(403, <String, Object?>{'error': 'not_permitted', 'message': 'no'})).receivables('Mokoena');
    expect(refused.status, 403);
    expect((refused.body as Map)['error'], 'not_permitted');
    final html = await api((r) async => http.Response('<html>bad gateway</html>', 502)).receivables('Mokoena');
    expect(html.status, 502);
    expect(html.body, isNull);
    final empty = await api((r) async => http.Response('', 204)).pending();
    expect(empty.status, 204);
    expect(empty.body, isNull);
  });

  test('an address that is not https is refused, a local one is allowed, and so is an empty token', () {
    expect(() => HttpEngineApi(baseUrl: 'http://office.example.test', sessionToken: _token), throwsArgumentError);
    expect(() => HttpEngineApi(baseUrl: 'ftp://office.example.test', sessionToken: _token), throwsArgumentError);
    expect(() => HttpEngineApi(baseUrl: 'https://office.example.test', sessionToken: ''), throwsArgumentError);
    expect(() => HttpEngineApi(baseUrl: 'https://office.example.test/', sessionToken: _token), returnsNormally);
    expect(() => HttpEngineApi(baseUrl: 'http://localhost:8787', sessionToken: _token), returnsNormally);
    expect(() => HttpEngineApi(baseUrl: 'http://127.0.0.1:8787', sessionToken: _token), returnsNormally);
  });

  testWidgets('the engine shell runs on the real client exactly as it runs on the fixtures: ask, answer, token in the header', (tester) async {
    final headersSeen = <String>[];
    final client = MockClient((r) async {
      headersSeen.add(r.headers['Authorization'] ?? '');
      final fx = r.url.path == '/engine/receivables' ? _fx['receivables-answer']! : _fx['unavailable-ask']!;
      return _json(fx.status, fx.body);
    });
    final live = HttpEngineApi(baseUrl: 'https://office.example.test', sessionToken: _token, client: client);
    await tester.pumpWidget(MaterialApp(home: EngineShell(api: live)));
    await tester.pump(const Duration(milliseconds: 50));
    await tester.enterText(find.byKey(const Key('ask-field')), 'What does Mokoena owe me?');
    await tester.tap(find.byKey(const Key('ask-send')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 100));
    expect(find.text('R850.00'), findsOneWidget);
    expect(headersSeen, <String>['Bearer $_token']);
  });
}
