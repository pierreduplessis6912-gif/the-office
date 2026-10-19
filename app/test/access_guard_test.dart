// The app's handling of a business whose access has ended (lib/access_guard.dart). The backend answers every request from such a business with 401 and {"code": "access_ended"}. What this pins: ONLY that exact answer raises the signal (any other 401, any other
// status, and a non-JSON body do not); every response reaches the caller exactly as it arrived; the shared client is never closed by a per-call close(); the zone mechanism main.dart relies on (http.runWithClient) really wraps top-level calls; and the screen replaces
// the home, closes anything open on top of it, and goes away on "Sign in".
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:the_office/access_guard.dart';

class _Tracking extends http.BaseClient {
  _Tracking(this._inner);
  final http.Client _inner;
  bool closed = false;
  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) => _inner.send(request);
  @override
  void close() => closed = true;
}

http.Client _answers(int status, String body, {Map<String, String> headers = const {}}) => MockClient((request) async => http.Response(body, status, headers: headers));

void main() {
  group('which answers raise the signal', () {
    for (final entry in <String, List<Object>>{
      'a 401 saying access_ended': [401, '{"error":"The subscription has ended.","code":"access_ended"}', true],
      'a 401 with another code': [401, '{"error":"sign in required","code":"signed_out"}', false],
      'a 401 with no code': [401, '{"error":"sign in required"}', false],
      'a 401 that is not JSON': [401, '<html>nope</html>', false],
      'a 401 with an empty body': [401, '', false],
      'a 401 whose JSON is a list': [401, '["access_ended"]', false],
      'a 401 with the code in the wrong case': [401, '{"code":"ACCESS_ENDED"}', false],
      'a 401 with the code as a number': [401, '{"code":1}', false],
      'a 403 saying access_ended': [403, '{"code":"access_ended"}', false],
      'a 200 saying access_ended': [200, '{"code":"access_ended"}', false],
      'a 500': [500, 'boom', false],
      'an ordinary 200': [200, '{"ok":true}', false],
    }.entries) {
      test(entry.key, () async {
        final signal = AccessSignal();
        final client = AccessAwareClient(_answers(entry.value[0] as int, entry.value[1] as String), signal);
        final response = await http.Response.fromStream(await client.send(http.Request('GET', Uri.parse('https://x.test/team'))));
        expect(signal.ended.value, entry.value[2]);
        expect(response.statusCode, entry.value[0]);
        expect(response.body, entry.value[1]); // the caller sees EXACTLY what the server said
      });
    }
  });

  test('the caller still sees the original 401, its body and its headers', () async {
    final signal = AccessSignal();
    final client = AccessAwareClient(_answers(401, '{"code":"access_ended","error":"x"}', headers: {'content-type': 'application/json', 'x-custom': 'kept'}), signal);
    final response = await http.Response.fromStream(await client.send(http.Request('POST', Uri.parse('https://x.test/messages/text'))));
    expect(response.statusCode, 401);
    expect(jsonDecode(response.body)['code'], 'access_ended');
    expect(response.headers['x-custom'], 'kept');
    expect(response.headers['content-type'], contains('application/json'));
  });

  test('a body that is not touched streams through (a 200 is not buffered by the wrapper)', () async {
    final signal = AccessSignal();
    final client = AccessAwareClient(MockClient.streaming((request, _) async => http.StreamedResponse(Stream.fromIterable([utf8.encode('a'), utf8.encode('b')]), 200)), signal);
    final response = await client.send(http.Request('GET', Uri.parse('https://x.test/x')));
    expect(await response.stream.bytesToString(), 'ab');
    expect(signal.ended.value, false);
  });

  test('many refused requests raise the signal ONCE', () async {
    final signal = AccessSignal();
    var effects = 0;
    signal.onEnded = () => effects++;
    final client = AccessAwareClient(_answers(401, '{"code":"access_ended"}'), signal);
    for (var i = 0; i < 5; i++) {
      await client.send(http.Request('GET', Uri.parse('https://x.test/team')));
    }
    expect(effects, 1);
  });

  test('a failing side effect (clearing the session) never stops the signal', () async {
    final signal = AccessSignal()..onEnded = () => throw StateError('storage is broken');
    final client = AccessAwareClient(_answers(401, '{"code":"access_ended"}'), signal);
    await client.send(http.Request('GET', Uri.parse('https://x.test/team')));
    expect(signal.ended.value, true);
  });

  test('closing the wrapper does NOT close the shared client (package:http closes a client after every top-level call)', () async {
    final inner = _Tracking(_answers(200, 'ok'));
    final client = AccessAwareClient(inner, AccessSignal());
    client.close();
    expect(inner.closed, false);
    final response = await http.Response.fromStream(await client.send(http.Request('GET', Uri.parse('https://x.test/x'))));
    expect(response.body, 'ok'); // and it still works afterwards
  });

  test('http.runWithClient wraps the TOP-LEVEL calls main.dart makes (get, post, and a multipart upload)', () async {
    final signal = AccessSignal();
    final shared = _answers(401, '{"code":"access_ended"}');
    await http.runWithClient(() async {
      final got = await http.get(Uri.parse('https://x.test/team'));
      expect(got.statusCode, 401);
    }, () => AccessAwareClient(shared, signal));
    expect(signal.ended.value, true);

    final second = AccessSignal();
    await http.runWithClient(() async {
      final posted = await http.post(Uri.parse('https://x.test/messages/text'), body: '{}');
      expect(posted.statusCode, 401);
      final upload = http.MultipartRequest('POST', Uri.parse('https://x.test/files/audio'))..fields['k'] = 'v';
      final sent = await http.Response.fromStream(await upload.send());
      expect(sent.statusCode, 401);
    }, () => AccessAwareClient(shared, second));
    expect(second.ended.value, true);
  });

  testWidgets('the gate shows the app normally, replaces it when access ends, and "Sign in" brings it back', (tester) async {
    final signal = AccessSignal();
    final key = GlobalKey<NavigatorState>();
    await tester.pumpWidget(MaterialApp(navigatorKey: key, home: AccessGate(signal: signal, navigatorKey: key, child: const Text('the app'))));
    expect(find.text('the app'), findsOneWidget);
    expect(find.text('Your subscription has ended'), findsNothing);

    signal.trigger();
    await tester.pumpAndSettle();
    expect(find.text('the app'), findsNothing);
    expect(find.text('Your subscription has ended'), findsOneWidget);
    expect(find.textContaining('has not been deleted'), findsOneWidget);

    await tester.tap(find.text('Sign in'));
    await tester.pumpAndSettle();
    expect(signal.ended.value, false);
    expect(find.text('the app'), findsOneWidget);
    expect(find.text('Your subscription has ended'), findsNothing);
  });

  testWidgets('anything open on top (a dialog, a pushed page) is closed when access ends', (tester) async {
    final signal = AccessSignal();
    final key = GlobalKey<NavigatorState>();
    await tester.pumpWidget(MaterialApp(navigatorKey: key, home: AccessGate(signal: signal, navigatorKey: key, child: const Text('the app'))));
    key.currentState!.push(MaterialPageRoute<void>(builder: (_) => const Scaffold(body: Text('a room dialog'))));
    await tester.pumpAndSettle();
    expect(find.text('a room dialog'), findsOneWidget);

    signal.trigger();
    await tester.pumpAndSettle();
    expect(find.text('a room dialog'), findsNothing);
    expect(find.text('Your subscription has ended'), findsOneWidget);
  });

  testWidgets('the screen is announced to a screen reader (live region) and has no way to continue except signing in', (tester) async {
    final handle = tester.ensureSemantics();
    await tester.pumpWidget(MaterialApp(home: AccessEndedScreen(onSignIn: () {})));
    expect(find.byType(FilledButton), findsOneWidget);
    expect(tester.getSemantics(find.text('Your subscription has ended')).label, contains('Your subscription has ended'));
    handle.dispose();
  });
}
