// Front-end slice 4: reading the reply envelope (ENVELOPE.md, contract version 1). Slice 11 (2026-10-24) also reads version 2: `open_room` (a named screen) and
// structured role refusals. Version 2 parts are honoured ONLY in a version 2 envelope: in a version 1 envelope the modes open_room and refuse still read as speak.
//
// The envelope is additive: it says what the backend has already established and recommends how the app might present it. It is not an
// authorization mechanism, so nothing here can approve, reject or run anything: a held action is still confirmed or rejected only
// through the pending-action routes, which re-check on every call.
//
// This reader is defensive on purpose. fromReply never throws; a reply with no envelope, a version this app does not know (only 1 and 2 are read),
// or a malformed envelope gives null, and the app then behaves exactly as it did before the envelope existed. Lists are cut to 50 items and
// strings to 200 characters, the same bounds the server applies, so a hostile reply cannot make the app do unbounded work.
const int _maxItems = 50;
const int _maxText = 200;

/// Action types the server lists but the app shows as a choice between candidates, not as a confirm gesture.
const Set<String> ambiguityTypes = {'project_ambiguity', 'ambiguous_person'};

/// What the server suggests for presenting this reply. A suggestion only; an unknown or missing value reads as [speak].
enum EnvelopeMode { speak, confirm, clarify, openRoom, refuse }

/// Screens the server may ask the app to open by name (version 2). Any other name is not opened: the reply reads as speak.
const Set<String> knownRooms = {'financial_snapshot', 'aged_debtors'};

const Set<String> _refusalReasons = {'role_cannot_record', 'role_cannot_see', 'role_cannot_see_part', 'role_cannot_record_part'};
final RegExp _topicPattern = RegExp(r'^[a-z_]{1,40}$');

/// A role refusal the server stated in structure (version 2): why, and about what. Never free text, a name or an amount.
class EnvelopeRefusal {
  final String reason;
  final String topic;
  const EnvelopeRefusal({required this.reason, required this.topic});
}

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

  /// Version 2: the screen to open when [mode] is [EnvelopeMode.openRoom] (always one of [knownRooms]); null otherwise.
  final String? room;

  /// Version 2: the refusals the server stated, and whether they were the WHOLE reply (only then is [mode] [EnvelopeMode.refuse]).
  final List<EnvelopeRefusal> refusals;
  final bool refusalIsWhole;

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
    this.room,
    this.refusals = const <EnvelopeRefusal>[],
    this.refusalIsWhole = false,
  });

  /// True when the whole reply is a role refusal the server stated in structure. A suggestion for presentation only: the words are still in `message`.
  bool get isRefusal => mode == EnvelopeMode.refuse;

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
      final version = raw['version'];
      if (version != 1 && version != 2) return null;
      final v2 = version == 2;

      final established = raw['established'];
      final recommendation = raw['recommendation'];
      final mustStillPass = raw['mustStillPass'];
      final est = established is Map ? established : const <Object?, Object?>{};
      final rec = recommendation is Map ? recommendation : const <Object?, Object?>{};
      final must = mustStillPass is Map ? mustStillPass : const <Object?, Object?>{};

      // Version 2 parts, read only from a version 2 envelope and only when they pass the vocabulary; anything else falls back to speak.
      final roomText = v2 ? _text(rec['room']) : null;
      final room = roomText != null && knownRooms.contains(roomText) ? roomText : null;
      final refusalsRaw = v2 ? est['refusals'] : null;
      final refusals = <EnvelopeRefusal>[];
      var whole = false;
      if (refusalsRaw is Map) {
        whole = refusalsRaw['scope'] == 'whole';
        for (final e in _items(refusalsRaw['items'])) {
          if (e is! Map) continue;
          final reason = _text(e['reason']);
          final topic = _text(e['topic']);
          if (reason != null && _refusalReasons.contains(reason) && topic != null && _topicPattern.hasMatch(topic)) {
            refusals.add(EnvelopeRefusal(reason: reason, topic: topic));
          }
        }
      }
      var mode = switch (rec['mode']) {
        'confirm' => EnvelopeMode.confirm,
        'clarify' => EnvelopeMode.clarify,
        'open_room' when v2 => EnvelopeMode.openRoom,
        'refuse' when v2 => EnvelopeMode.refuse,
        _ => EnvelopeMode.speak,
      };
      if (mode == EnvelopeMode.openRoom && room == null) mode = EnvelopeMode.speak;
      if (mode == EnvelopeMode.refuse && (refusals.isEmpty || !whole)) mode = EnvelopeMode.speak;

      return ReplyEnvelope(
        version: version as int,
        from: _strings(est['from']),
        heldActions: [
          for (final e in _items(est['heldActions']))
            if (e is Map && _wholeId(e['id'])) HeldAction(id: e['id'] as int, type: _text(e['type'])),
        ],
        candidates: [
          for (final e in _items(est['candidates']))
            if (e is Map && _wholeId(e['id']) && _text(e['name']) != null) EnvelopeCandidate(id: e['id'] as int, name: _text(e['name'])!),
        ],
        changes: [
          for (final e in _items(est['changes']))
            if (e is Map && _text(e['field']) != null && _text(e['label']) != null && _text(e['displayValue']) != null)
              EnvelopeChange(field: _text(e['field'])!, label: _text(e['label'])!, displayValue: _text(e['displayValue'])!),
        ],
        mode: mode,
        speak: _text(rec['speak']),
        unknown: _strings(raw['unknown']),
        confirmationRequired: must['confirmationRequired'] == true,
        room: mode == EnvelopeMode.openRoom ? room : null,
        refusals: refusals,
        refusalIsWhole: whole && refusals.isNotEmpty,
      );
    } catch (_) {
      return null;
    }
  }
}

/// The server's own rule for an id: a positive whole number.
bool _wholeId(Object? v) => v is int && v > 0;

List<Object?> _items(Object? v) => v is List ? v.take(_maxItems).toList() : const <Object?>[];

String? _text(Object? v) {
  if (v is! String) return null;
  return v.length > _maxText ? v.substring(0, _maxText) : v;
}

List<String> _strings(Object? v) => [for (final e in _items(v)) if (_text(e) != null) _text(e)!];
