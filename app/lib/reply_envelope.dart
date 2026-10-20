// Front-end slice 4: reading the reply envelope (ENVELOPE.md, contract version 1).
//
// The envelope is additive: it says what the backend has already established and recommends how the app might present it. It is not an
// authorization mechanism, so nothing here can approve, reject or run anything: a held action is still confirmed or rejected only
// through the pending-action routes, which re-check on every call.
//
// This reader is defensive on purpose. fromReply never throws; a reply with no envelope, a version this app does not know (only 1 is read),
// or a malformed envelope gives null, and the app then behaves exactly as it did before the envelope existed. Lists are cut to 50 items and
// strings to 200 characters, the same bounds the server applies, so a hostile reply cannot make the app do unbounded work.
const int _maxItems = 50;
const int _maxText = 200;

/// Action types the server lists but the app shows as a choice between candidates, not as a confirm gesture.
const Set<String> ambiguityTypes = {'project_ambiguity', 'ambiguous_person'};

/// What the server suggests for presenting this reply. A suggestion only; an unknown or missing value reads as [speak].
enum EnvelopeMode { speak, confirm, clarify }

class HeldAction {
  final int id;
  final String? type;
  const HeldAction({required this.id, this.type});
}

class EnvelopeCandidate {
  final int id;
  final String name;
  const EnvelopeCandidate({required this.id, required this.name});
}

class EnvelopeChange {
  final String field;
  final String label;
  final String displayValue;
  const EnvelopeChange({required this.field, required this.label, required this.displayValue});
}

class ReplyEnvelope {
  final int version;
  final List<String> from;
  final List<HeldAction> heldActions;
  final List<EnvelopeCandidate> candidates;
  final List<EnvelopeChange> changes;
  final EnvelopeMode mode;
  final String? speak;
  final List<String> unknown;
  final bool confirmationRequired;

  const ReplyEnvelope({
    required this.version,
    required this.from,
    required this.heldActions,
    required this.candidates,
    required this.changes,
    required this.mode,
    required this.speak,
    required this.unknown,
    required this.confirmationRequired,
  });

  /// Held actions the app can offer a confirm / reject gesture for (not the ones shown as a choice between candidates).
  List<HeldAction> get confirmable => heldActions.where((h) => !ambiguityTypes.contains(h.type)).toList();

  /// True when the server says a reply field was malformed or cut short, so the facts above may be incomplete.
  bool get mayBeIncomplete => unknown.any((u) => u.startsWith('reply_field_malformed:') || u.startsWith('reply_field_truncated:'));

  /// Reads the `experience` object of a decoded reply. Null when there is none the app can use. Never throws.
  static ReplyEnvelope? fromReply(Object? reply) {
    try {
      if (reply is! Map) return null;
      final raw = reply['experience'];
      if (raw is! Map) return null;
      if (raw['version'] != 1) return null;

      final established = raw['established'];
      final recommendation = raw['recommendation'];
      final mustStillPass = raw['mustStillPass'];
      final est = established is Map ? established : const <Object?, Object?>{};
      final rec = recommendation is Map ? recommendation : const <Object?, Object?>{};
      final must = mustStillPass is Map ? mustStillPass : const <Object?, Object?>{};

      return ReplyEnvelope(
        version: 1,
        from: _strings(est['from']),
        heldActions: [
          for (final e in _items(est['heldActions']))
            if (e is Map && e['id'] is int) HeldAction(id: e['id'] as int, type: _text(e['type'])),
        ],
        candidates: [
          for (final e in _items(est['candidates']))
            if (e is Map && e['id'] is int && _text(e['name']) != null) EnvelopeCandidate(id: e['id'] as int, name: _text(e['name'])!),
        ],
        changes: [
          for (final e in _items(est['changes']))
            if (e is Map && _text(e['field']) != null && _text(e['label']) != null && _text(e['displayValue']) != null)
              EnvelopeChange(field: _text(e['field'])!, label: _text(e['label'])!, displayValue: _text(e['displayValue'])!),
        ],
        mode: switch (rec['mode']) { 'confirm' => EnvelopeMode.confirm, 'clarify' => EnvelopeMode.clarify, _ => EnvelopeMode.speak },
        speak: _text(rec['speak']),
        unknown: _strings(raw['unknown']),
        confirmationRequired: must['confirmationRequired'] == true,
      );
    } catch (_) {
      return null;
    }
  }
}

List<Object?> _items(Object? v) => v is List ? v.take(_maxItems).toList() : const <Object?>[];

String? _text(Object? v) {
  if (v is! String) return null;
  return v.length > _maxText ? v.substring(0, _maxText) : v;
}

List<String> _strings(Object? v) => [for (final e in _items(v)) if (_text(e) != null) _text(e)!];
