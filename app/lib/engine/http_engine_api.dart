// The REAL way the engine shell reaches the engine: the same EngineApi the shell already runs on, over HTTP, to the routes the backend slice test walks (/engine/receivables, /engine/records/<kind>/<id>, /engine/proposals, /actions/pending,
// /actions/<id>/confirm), signed in with the same bearer session token the production app uses. NOTHING USES IT YET: the demo entry point (lib/engine_main.dart) runs on recorded answers, and connecting the shell to a real engine business
// (which needs a signed-in session for a business that is in engine mode) is a separate step that needs Pierre's approval. It holds no credential: the token is handed in, never stored here, never logged, and never put in a URL.
import 'dart:convert';

import 'package:http/http.dart' as http;

import 'engine_api.dart';

class HttpEngineApi implements EngineApi {
  final String baseUrl;
  final String sessionToken;
  final http.Client client;
  final Duration timeout;

  /// [baseUrl] must be https (or a local address for development); a token is never sent in the clear to anywhere else.
  HttpEngineApi({required String baseUrl, required this.sessionToken, http.Client? client, this.timeout = const Duration(seconds: 20)})
      : baseUrl = baseUrl.endsWith('/') ? baseUrl.substring(0, baseUrl.length - 1) : baseUrl,
        client = client ?? http.Client() {
    final secure = baseUrl.startsWith('https://');
    final local = baseUrl.startsWith('http://localhost') || baseUrl.startsWith('http://127.0.0.1');
    if (!secure && !local) throw ArgumentError('The engine address must be https.');
    if (sessionToken.isEmpty) throw ArgumentError('A session token is needed.');
  }

  static final RegExp _safeSegment = RegExp(r'^[a-z_]{1,32}$');
  static const EngineResponse _notFound = EngineResponse(404, <String, Object?>{'error': 'not_found', 'message': 'There is no such record.'});

  Map<String, String> _headers({bool json = false}) => <String, String>{'Authorization': 'Bearer $sessionToken', if (json) 'Content-Type': 'application/json'};

  EngineResponse _wrap(http.Response response) {
    Object? body;
    try {
      body = response.bodyBytes.isEmpty ? null : jsonDecode(utf8.decode(response.bodyBytes));
    } catch (_) {
      body = null;
    }
    return EngineResponse(response.statusCode, body);
  }

  Future<EngineResponse> _get(String path) async => _wrap(await client.get(Uri.parse('$baseUrl$path'), headers: _headers()).timeout(timeout));

  Future<EngineResponse> _post(String path, Object body) async => _wrap(await client.post(Uri.parse('$baseUrl$path'), headers: _headers(json: true), body: jsonEncode(body)).timeout(timeout));

  @override
  Future<EngineResponse> receivables(String party) => _get('/engine/receivables?party=${Uri.encodeQueryComponent(party)}');

  @override
  Future<EngineResponse> record(String kind, int id) async {
    if (!_safeSegment.hasMatch(kind) || id < 1) return _notFound;
    return _get('/engine/records/$kind/$id');
  }

  @override
  Future<EngineResponse> proposePayment(Map<String, Object?> payload, String transcript) =>
      _post('/engine/proposals', <String, Object?>{'capability': 'payment.record', 'payload': payload, 'transcript': transcript, 'source': 'app'});

  @override
  Future<EngineResponse> pending() => _get('/actions/pending');

  @override
  Future<EngineResponse> confirm(int actionId) => _post('/actions/$actionId/confirm', <String, Object?>{});

  @override
  Future<EngineResponse> reject(int actionId) => _post('/actions/$actionId/reject', <String, Object?>{});
}
