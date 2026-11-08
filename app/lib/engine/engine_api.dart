// How the engine shell reaches the engine. The shell depends only on this interface, so it can be built and tested against recorded answers (FixtureEngineApi) before any real connection exists; a real one
// (signed in, over HTTP, to an engine business on staging) is a separate step that needs Pierre's approval. Nothing here decides what a member may see: the engine does, and the fixtures are the engine's own recorded answers
// (app/test/fixtures/slice, kept equal to the backend by tools/slice-mokoena.test.js).
import 'dart:convert';

class EngineResponse {
  final int status;
  final Object? body;
  const EngineResponse(this.status, this.body);

  /// Reads one fixture file ({"status": 200, "body": ...}). Null when it is not that shape.
  static EngineResponse? fromFixtureJson(String json) {
    try {
      final decoded = jsonDecode(json);
      if (decoded is! Map || decoded['status'] is! int) return null;
      return EngineResponse(decoded['status'] as int, decoded['body']);
    } catch (_) {
      return null;
    }
  }
}

/// Reads embedded fixture text (name to file text, as in engine_fixtures.dart) into responses. Anything not of the fixture shape is left out.
Map<String, EngineResponse> engineResponsesFrom(Map<String, String> json) {
  final out = <String, EngineResponse>{};
  json.forEach((name, text) {
    final response = EngineResponse.fromFixtureJson(text);
    if (response != null) out[name] = response;
  });
  return out;
}

abstract class EngineApi {
  /// What a customer owes: GET /engine/receivables?party=<name or number>.
  Future<EngineResponse> receivables(String party);

  /// A record opened from an answer: GET /engine/records/<kind>/<id>.
  Future<EngineResponse> record(String kind, int id);

  /// Proposes recording a payment: POST /engine/proposals. The engine HOLDS it; nothing is recorded until it is confirmed.
  Future<EngineResponse> proposePayment(Map<String, Object?> payload, String transcript);

  /// What is waiting for approval: GET /actions/pending.
  Future<EngineResponse> pending();

  /// Approves a held action: POST /actions/<id>/confirm.
  Future<EngineResponse> confirm(int actionId);

  /// Declines a held action: POST /actions/<id>/reject. Nothing is recorded.
  Future<EngineResponse> reject(int actionId);
}

/// Answers from recorded engine responses, chosen by who is asking and what the business has. [fixtures] is keyed by fixture name without its extension.
class FixtureEngineApi implements EngineApi {
  final Map<String, EngineResponse> fixtures;

  /// The member's role. An installer or sales member is refused by the engine; the recorded refusal is what comes back.
  final String role;

  /// False stands for a business without the capability (Business B).
  final bool capabilityAvailable;

  /// True stands for a business with two customers called Mokoena.
  final bool ambiguous;
  /// False stands for a member who may read but not record payments: the engine refuses the proposal.
  final bool canRecord;

  /// True stands for an account that changed between the proposal and the approval: the engine refuses the approval as stale.
  final bool staleApproval;

  /// What the shell sent, for tests to check: every proposed payload, and every action number approved.
  final List<Map<String, Object?>> proposals = <Map<String, Object?>>[];
  final List<int> confirmations = <int>[];
  final List<int> rejections = <int>[];
  bool _approved = false;
  bool _rejected = false;

  /// False stands for a member who may not decline a held payment: the engine refuses it and the payment still waits.
  final bool canDecline;

  /// True stands for a payment larger than what is owed (R1,000.00 against R850.00): the held view shows the unallocated remainder and, once approved, the customer owes nothing.
  final bool overpay;

  FixtureEngineApi(this.fixtures, {this.role = 'accountant', this.capabilityAvailable = true, this.ambiguous = false, this.canRecord = true, this.staleApproval = false, this.canDecline = true, this.overpay = false});

  static const EngineResponse _missing = EngineResponse(500, null);

  /// What the engine answers for a record that is hidden from the member or does not exist: the same thing either way.
  static const EngineResponse _notFound = EngineResponse(404, <String, Object?>{'error': 'not_found', 'message': 'There is no such record.'});

  /// The recorded record views, by what they open: the invoice, the customer, and the first payment (reversed).
  static const Map<String, String> _recordFixtures = <String, String>{
    'document/1': 'record-document',
    'party/1': 'record-party',
    'movement/1': 'record-movement-reversed',
  };

  @override
  Future<EngineResponse> receivables(String party) async {
    if (!capabilityAvailable) return fixtures['unavailable-ask'] ?? _missing;
    if (role == 'installer' || role == 'sales') return fixtures['receivables-refused'] ?? _missing;
    if (party.trim().toLowerCase() != 'mokoena') return fixtures['receivables-not-found'] ?? _missing;
    return fixtures[ambiguous ? 'receivables-ambiguous' : (_approved ? (overpay ? 'receivables-after-overpay' : 'receivables-after-payment') : 'receivables-answer')] ?? _missing;
  }

  @override
  Future<EngineResponse> record(String kind, int id) async {
    if (!capabilityAvailable) return fixtures['unavailable-ask'] ?? _missing;
    if (role == 'installer' || role == 'sales') return _notFound;
    final name = _recordFixtures['$kind/$id'];
    if (name == null) return _notFound;
    return fixtures[(_approved && name == 'record-document') ? 'record-document-after-payment' : name] ?? _notFound;
  }

  @override
  Future<EngineResponse> proposePayment(Map<String, Object?> payload, String transcript) async {
    proposals.add(Map<String, Object?>.from(payload));
    if (!capabilityAvailable) return fixtures['unavailable-proposal'] ?? _missing;
    if (!canRecord || role == 'installer' || role == 'sales') return fixtures['proposal-refused'] ?? _missing;
    return fixtures['proposal-held'] ?? _missing;
  }

  @override
  Future<EngineResponse> pending() async => fixtures[_rejected ? 'pending-empty' : (overpay ? 'pending-held-over' : 'pending-held')] ?? _missing;

  @override
  Future<EngineResponse> confirm(int actionId) async {
    confirmations.add(actionId);
    if (_rejected) return fixtures['confirm-after-reject'] ?? _missing;
    if (staleApproval) return fixtures['confirm-stale'] ?? _missing;
    _approved = true;
    return fixtures['confirm-ok'] ?? _missing;
  }

  @override
  Future<EngineResponse> reject(int actionId) async {
    rejections.add(actionId);
    if (!canDecline || role == 'installer' || role == 'sales') return fixtures['reject-refused'] ?? _missing;
    _rejected = true;
    return fixtures['reject-ok'] ?? _missing;
  }
}
