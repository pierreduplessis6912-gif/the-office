// The owner's "Subscription" item (lib/plans_link.dart). What this pins: the request is exactly a POST to /billing/plans-link with the session's authorization header; ONLY a link that is https, on our own host, at /billing/plans, with a token and with no
// credentials, odd port or fragment is ever opened (anything else is "unavailable", so a wrong or tampered answer can never send an owner to another site); a 401 means sign in again, a 403 means not the owner, and every other failure (a 404, a 500, a body that is
// not JSON, no network) is "unavailable"; it never throws; and it works through the access-ended client from slice 1.
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:the_office/access_guard.dart';
import 'package:the_office/plans_link.dart';

const _base = 'https://office.test';
const _good = 'https://office.test/billing/plans?t=abc.def';

Future<PlansLinkResult> _ask(http.Client client, {Map<String, String> headers = const {'Authorization': 'Bearer tok'}}) => http.runWithClient(() => requestPlansLink(apiBase: _base, headers: headers), () => client);
http.Client _says(int status, String body) => MockClient((request) async => http.Response(body, status));

void main() {
  test('the request is a POST to /billing/plans-link carrying the session header', () async {
    http.Request? seen;
    final result = await _ask(MockClient((request) async {
      seen = request;
      return http.Response('{"url":"$_good"}', 200);
    }));
    expect(seen!.method, 'POST');
    expect(seen!.url.toString(), '$_base/billing/plans-link');
    expect(seen!.headers['Authorization'], 'Bearer tok');
    expect(result.outcome, PlansLinkOutcome.ready);
    expect(result.url.toString(), _good);
    expect(result.message, '');
  });

  group('only the link the server really makes is opened', () {
    for (final entry in <String, Object?>{
      'another host': 'https://evil.example/billing/plans?t=abc',
      'a look-alike host': 'https://office.test.evil.example/billing/plans?t=abc',
      'a subdomain': 'https://x.office.test/billing/plans?t=abc',
      'plain http': 'http://office.test/billing/plans?t=abc',
      'another path': 'https://office.test/billing/checkout?t=abc',
      'a longer path': 'https://office.test/billing/plans/extra?t=abc',
      'no token': 'https://office.test/billing/plans',
      'an empty token': 'https://office.test/billing/plans?t=',
      'credentials in the link': 'https://user:pw@office.test/billing/plans?t=abc',
      'a user name only': 'https://user@office.test/billing/plans?t=abc',
      'an odd port': 'https://office.test:8443/billing/plans?t=abc',
      'a fragment': 'https://office.test/billing/plans?t=abc#x',
      'a relative link': '/billing/plans?t=abc',
      'a javascript link': 'javascript:alert(1)',
      'an empty string': '',
      'a number': 123,
      'a list': ['https://office.test/billing/plans?t=abc'],
      'null': null,
    }.entries) {
      test('refused: ${entry.key}', () async {
        final body = entry.value is String ? '{"url":${_jsonString(entry.value as String)}}' : '{"url":${_encode(entry.value)}}';
        final result = await _ask(_says(200, body));
        expect(result.outcome, PlansLinkOutcome.unavailable);
        expect(result.url, isNull);
      });
    }
    test('the standard port written out is fine', () async {
      final result = await _ask(_says(200, '{"url":"https://office.test:443/billing/plans?t=abc"}'));
      expect(result.outcome, PlansLinkOutcome.ready);
    });
  });

  group('what each answer means', () {
    for (final entry in <int, PlansLinkOutcome>{401: PlansLinkOutcome.signedOut, 403: PlansLinkOutcome.notOwner, 404: PlansLinkOutcome.unavailable, 409: PlansLinkOutcome.unavailable, 429: PlansLinkOutcome.unavailable, 500: PlansLinkOutcome.unavailable, 502: PlansLinkOutcome.unavailable}.entries) {
      test('${entry.key} is ${entry.value.name}', () async {
        final result = await _ask(_says(entry.key, '{"error":"x"}'));
        expect(result.outcome, entry.value);
        expect(result.url, isNull);
        expect(result.message, isNotEmpty);
      });
    }
    for (final body in ['', 'not json', '[]', '"text"', '{}', '{"nope":1}', '{"url":null}']) {
      test('a 200 with the body ${body.isEmpty ? "(empty)" : body} is unavailable', () async {
        expect((await _ask(_says(200, body))).outcome, PlansLinkOutcome.unavailable);
      });
    }
    test('no network is unavailable, and nothing is thrown', () async {
      final result = await _ask(MockClient((request) async => throw http.ClientException('offline')));
      expect(result.outcome, PlansLinkOutcome.unavailable);
    });
    test('the words the person sees', () {
      expect(PlansLinkResult.signedOut().message, 'Please sign in again.');
      expect(PlansLinkResult.notOwner().message, 'Only the owner can manage the subscription.');
      expect(PlansLinkResult.unavailable().message, 'The plans page is not available right now. Please try again.');
      expect(plansCouldNotOpenMessage, 'Could not open the browser. Please try again.');
    });
  });

  test('a business whose access has ended is sent to the "subscription ended" screen, and the item says to sign in', () async {
    final signal = AccessSignal();
    final client = AccessAwareClient(_says(401, '{"error":"The subscription has ended.","code":"access_ended"}'), signal);
    final result = await _ask(client);
    expect(signal.ended.value, true);
    expect(result.outcome, PlansLinkOutcome.signedOut);
  });
}

String _jsonString(String s) => '"${s.replaceAll(r'\', r'\\').replaceAll('"', r'\"')}"';
String _encode(Object? v) => v == null ? 'null' : v is num ? '$v' : v is List ? '[${v.map((e) => _jsonString('$e')).join(',')}]' : _jsonString('$v');
