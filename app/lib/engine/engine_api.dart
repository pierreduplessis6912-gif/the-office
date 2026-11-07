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

abstract class EngineApi {
  /// What a customer owes: GET /engine/receivables?party=<name or number>.
  Future<EngineResponse> receivables(String party);
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
  const FixtureEngineApi(this.fixtures, {this.role = 'accountant', this.capabilityAvailable = true, this.ambiguous = false});

  static const EngineResponse _missing = EngineResponse(500, null);

  @override
  Future<EngineResponse> receivables(String party) async {
    if (!capabilityAvailable) return fixtures['unavailable-ask'] ?? _missing;
    if (role == 'installer' || role == 'sales') return fixtures['receivables-refused'] ?? _missing;
    if (party.trim().toLowerCase() != 'mokoena') return fixtures['receivables-not-found'] ?? _missing;
    return fixtures[ambiguous ? 'receivables-ambiguous' : 'receivables-answer'] ?? _missing;
  }
}
