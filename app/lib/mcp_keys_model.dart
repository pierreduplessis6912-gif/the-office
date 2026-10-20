// Front-end slice 10: the owner's read-only keys for outside assistants (backend: worker/src/mcp-keys.ts and the /mcp-keys routes; MCP_ARCHITECTURE.md). The owner creates a key here, sees it ONCE, and can revoke it. A key lets an assistant (Claude, Cursor and the like) READ the business's figures as the owner; it can change nothing. These readers are defensive like the others: they never throw, skip what is malformed, and bound what they read.
import 'history_model.dart';

const int _maxKeys = 50;
const int _maxText = 200;

class McpKey {
  final String id;
  final String label;
  final String email;
  final String? lastUsedAt;
  final String? revokedAt;
  final int uses;
  final String? createdAt;
  const McpKey({required this.id, required this.label, required this.email, this.lastUsedAt, this.revokedAt, this.uses = 0, this.createdAt});
  bool get active => revokedAt == null;
}

final RegExp _keyId = RegExp(r'^[0-9a-f]{16}$');

/// Reads a decoded GET /mcp-keys body. Null when it is not one. Never throws; an entry without a proper 16-character id and a label is skipped.
List<McpKey>? parseKeyList(Object? body) {
  try {
    if (body is! Map || body['keys'] is! List) return null;
    final out = <McpKey>[];
    for (final raw in (body['keys'] as List).take(_maxKeys)) {
      if (raw is! Map) continue;
      final id = raw['id'];
      final label = _t(raw['label']);
      if (id is! String || !_keyId.hasMatch(id) || label == null) continue;
      final uses = raw['uses'];
      out.add(McpKey(id: id, label: label, email: _t(raw['email']) ?? '', lastUsedAt: _t(raw['last_used_at']), revokedAt: _t(raw['revoked_at']), uses: uses is int && uses >= 0 ? uses : 0, createdAt: _t(raw['created_at'])));
    }
    return out;
  } catch (_) {
    return null;
  }
}

class IssuedKey {
  final String id;
  final String key; // shown ONCE: the caller must not keep it
  final String label;
  const IssuedKey({required this.id, required this.key, required this.label});
}

/// Reads the answer to POST /mcp-keys. Null unless it carries a key in exactly the key format (omk.<business>.<id>.<secret>) whose id matches. Never throws.
IssuedKey? parseIssued(Object? body) {
  try {
    if (body is! Map || body['shownOnce'] != true) return null;
    final id = body['id'];
    final key = body['key'];
    final label = _t(body['label']);
    if (id is! String || !_keyId.hasMatch(id) || key is! String || key.length > 200 || label == null) return null;
    final parts = key.split('.');
    if (parts.length != 4 || parts[0] != 'omk' || parts[2] != id || !RegExp(r'^[A-Za-z0-9_-]{43}$').hasMatch(parts[3])) return null;
    return IssuedKey(id: id, key: key, label: label);
  } catch (_) {
    return null;
  }
}

String? _t(Object? v) {
  if (v is! String) return null;
  return v.length > _maxText ? v.substring(0, _maxText) : v;
}

/// The address an assistant connects to: the API base plus /mcp, whatever slashes the base ends with.
String mcpAddress(String apiBase) => '${apiBase.replaceAll(RegExp(r'/+$'), '')}/mcp';

/// "Never used", or "Last used 20 Oct 11:24, 14 calls".
String useLine(McpKey k) {
  final when = parseTurnTime(k.lastUsedAt);
  if (when == null) return 'Never used';
  return 'Last used ${formatShort(when.toLocal())}, ${k.uses == 1 ? '1 call' : '${k.uses} calls'}';
}

/// "Created 20 Oct 11:24" or an empty string.
String createdLine(McpKey k) {
  final when = parseTurnTime(k.createdAt);
  return when == null ? '' : 'Created ${formatShort(when.toLocal())}';
}

/// A label the owner typed, tidied: trimmed, at most 60 characters, no control characters; null when nothing usable is left.
String? tidyLabel(String raw) {
  final cleaned = raw.replaceAll(RegExp(r'[\u0000-\u001f\u007f]'), ' ').trim();
  if (cleaned.isEmpty) return null;
  return cleaned.length > 60 ? cleaned.substring(0, 60).trim() : cleaned;
}
