// The owner's view of what connected assistants created, and the undo of it (backend: worker/src/mcp-undo.ts and the /mcp-created routes; MCP_ARCHITECTURE.md). The list says what each thing is, which connection made it and whether it can still be undone; an invoice is voided (it keeps its number), anything else is removed with a copy kept. This file only READS the answers, strictly and without ever throwing; the screen is in main.dart.
import 'analysis_model.dart' show formatRand;
import 'history_model.dart';

const int _maxItems = 200;
const int _maxText = 200;
const Set<String> _kinds = {'invoice', 'quote', 'expense', 'task', 'job', 'payment'};
const Set<String> _states = {'active', 'undone', 'void', 'gone'};

class McpCreated {
  final int id; // the TAG's id: what the undo is asked for
  final int callId;
  final String connection;
  final String kind;
  final int recordId;
  final String? createdAt;
  final String state; // active, undone, void or gone
  final String? description;
  final double? amount;
  const McpCreated({required this.id, required this.callId, required this.connection, required this.kind, required this.recordId, this.createdAt, required this.state, this.description, this.amount});

  /// Only a record that is still there and not yet undone can be undone.
  bool get canUndo => state == 'active';
}

String? _t(Object? v) {
  if (v is! String) return null;
  final cleaned = v.replaceAll(RegExp(r'[\u0000-\u001f\u007f]'), ' ').trim();
  if (cleaned.isEmpty) return null;
  return cleaned.length > _maxText ? cleaned.substring(0, _maxText) : cleaned;
}

int? _posInt(Object? v) => v is int && v > 0 ? v : null;

/// Reads a decoded GET /mcp-created body. Null when it is not one. An entry that is not exactly what the backend sends (a real tag id, a known kind and state) is skipped.
List<McpCreated>? parseCreatedList(Object? body) {
  try {
    if (body is! Map || body['items'] is! List) return null;
    final out = <McpCreated>[];
    for (final raw in (body['items'] as List).take(_maxItems)) {
      if (raw is! Map) continue;
      final id = _posInt(raw['id']);
      final callId = _posInt(raw['callId']);
      final recordId = _posInt(raw['recordId']);
      final kind = raw['kind'];
      final state = raw['state'];
      if (id == null || callId == null || recordId == null || kind is! String || !_kinds.contains(kind) || state is! String || !_states.contains(state)) continue;
      final summary = raw['summary'];
      final amount = summary is Map && summary['amount'] is num ? (summary['amount'] as num).toDouble() : null;
      out.add(McpCreated(
        id: id,
        callId: callId,
        connection: _t(raw['connection']) ?? 'a connected assistant',
        kind: kind,
        recordId: recordId,
        createdAt: _t(raw['createdAt']),
        state: state,
        description: summary is Map ? _t(summary['description']) : null,
        amount: amount != null && amount.isFinite ? amount : null,
      ));
    }
    return out;
  } catch (_) {
    return null;
  }
}

String _capital(String s) => s.isEmpty ? s : s[0].toUpperCase() + s.substring(1);

/// "Invoice: Carpet repair, R3,000.00" (the description and the amount only when there are any).
String createdTitle(McpCreated c) {
  final parts = <String>[if (c.description != null) c.description!, if (c.amount != null) formatRand(c.amount!)];
  return parts.isEmpty ? _capital(c.kind) : '${_capital(c.kind)}: ${parts.join(', ')}';
}

/// "Claude on my phone  ·  20 Oct 11:24".
String createdSubtitle(McpCreated c) {
  final when = parseTurnTime(c.createdAt);
  return when == null ? c.connection : '${c.connection}  \u00b7  ${formatShort(when.toLocal())}';
}

/// What to show instead of an Undo button: nothing while it can still be undone.
String stateLabel(McpCreated c) {
  switch (c.state) {
    case 'undone':
      return c.kind == 'invoice' ? 'VOIDED' : 'REMOVED';
    case 'void':
      return 'VOID';
    case 'gone':
      return 'NO LONGER THERE';
    default:
      return '';
  }
}

/// The words to show after an undo, from the HTTP status and decoded body. Never throws; never shows more than the backend's own plain reason.
String undoMessage(int status, Object? body) {
  try {
    if (status == 200 && body is Map && body['ok'] == true) {
      return body['action'] == 'voided' ? 'Voided. The invoice keeps its number.' : 'Removed. A copy was kept.';
    }
    if (body is Map) {
      final reason = _t(body['message']) ?? _t(body['error']);
      if (reason != null) return reason;
    }
  } catch (_) {}
  if (status == 403) return 'Only the owner can undo this.';
  if (status == 404) return 'That is not something an assistant created.';
  return 'Could not undo that right now.';
}
