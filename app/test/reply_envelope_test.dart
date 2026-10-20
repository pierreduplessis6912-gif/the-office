// Front-end slice 4 (lib/reply_envelope.dart). What this pins: a well-formed version 1 envelope is read as the contract (ENVELOPE.md) describes;
// anything else (no envelope, another version, wrong shapes, hostile values) never throws and either reads as the safe default or as null, so
// the app behaves as it did before the envelope existed; lists and strings are bounded; and the held actions the app may offer a confirm
// gesture for exclude the ones shown as a choice between candidates. It does not test the screens: main.dart is not unit-testable yet.
import 'package:flutter_test/flutter_test.dart';
import 'package:the_office/reply_envelope.dart';

Map<String, Object?> _reply({Object? experience, String message = 'Done.'}) => {'message': message, if (experience != null) 'experience': experience};

Map<String, Object?> _envelope({
  Object? version = 1,
  Object? held = const [
    {'id': 12, 'type': 'invoice'}
  ],
  Object? candidates,
  Object? changes,
  Object? mode = 'confirm',
  Object? speak = 'Done.',
  Object? unknown = const ['intent_class', 'room'],
  Object? confirmationRequired = true,
}) =>
    {
      'version': version,
      'established': {'from': ['message', 'pendingActions'], 'heldActions': held, 'candidates': candidates, 'changes': changes},
      'recommendation': {'mode': mode, 'speak': speak},
      'unknown': unknown,
      'mustStillPass': {'confirmationRequired': confirmationRequired, 'through': 'the pending-action routes', 'authorization': 'checked again on every call'},
    };

void main() {
  test('a version 1 envelope is read as the contract describes', () {
    final e = ReplyEnvelope.fromReply(_reply(experience: _envelope(
      candidates: [{'id': 3, 'name': 'Jenny Smith'}],
      changes: [{'field': 'amount', 'label': 'Amount', 'displayValue': 'R 1,200.00'}],
    )))!;
    expect(e.version, 1);
    expect(e.from, ['message', 'pendingActions']);
    expect(e.heldActions.single.id, 12);
    expect(e.heldActions.single.type, 'invoice');
    expect(e.candidates.single.name, 'Jenny Smith');
    expect(e.changes.single.displayValue, 'R 1,200.00');
    expect(e.mode, EnvelopeMode.confirm);
    expect(e.speak, 'Done.');
    expect(e.unknown, ['intent_class', 'room']);
    expect(e.confirmationRequired, isTrue);
  });

  test('the three modes are read, and an unknown or missing mode reads as speak (a suggestion, never an instruction)', () {
    expect(ReplyEnvelope.fromReply(_reply(experience: _envelope(mode: 'clarify')))!.mode, EnvelopeMode.clarify);
    expect(ReplyEnvelope.fromReply(_reply(experience: _envelope(mode: 'speak')))!.mode, EnvelopeMode.speak);
    expect(ReplyEnvelope.fromReply(_reply(experience: _envelope(mode: 'refuse')))!.mode, EnvelopeMode.speak);
    expect(ReplyEnvelope.fromReply(_reply(experience: _envelope(mode: 7)))!.mode, EnvelopeMode.speak);
    expect(ReplyEnvelope.fromReply(_reply(experience: _envelope(mode: null)))!.mode, EnvelopeMode.speak);
  });

  test('no envelope, another version, or something that is not an envelope gives null (the app then behaves as before)', () {
    for (final reply in <Object?>[
      null, 'text', 42, <Object?>[], <String, Object?>{},
      _reply(), _reply(experience: 'x'), _reply(experience: <Object?>[]),
      _reply(experience: _envelope(version: 2)), _reply(experience: _envelope(version: '1')), _reply(experience: _envelope(version: null)),
    ]) {
      expect(ReplyEnvelope.fromReply(reply), isNull, reason: '$reply');
    }
  });

  test('a hostile or partial envelope never throws', () {
    final hostile = <Object?>[
      {'version': 1},
      {'version': 1, 'established': 'x', 'recommendation': 5, 'unknown': {'a': 1}, 'mustStillPass': []},
      {'version': 1, 'established': {'heldActions': 'nope', 'candidates': 7, 'changes': {'a': 1}, 'from': [1, null, {}]}},
      {'version': 1, 'established': {'heldActions': [null, 1, 'x', [], {'id': 'twelve'}, {'id': 1.5}, {'type': 'invoice'}]}},
      {'version': 1, 'established': {'candidates': [{'id': 1}, {'name': 'x'}, {'id': 'a', 'name': 'b'}], 'changes': [{'field': 'a'}, {'field': 1, 'label': 2, 'displayValue': 3}]}},
    ];
    for (final h in hostile) {
      final e = ReplyEnvelope.fromReply(_reply(experience: h));
      expect(e, isNotNull);
      expect(e!.heldActions, isEmpty);
      expect(e.candidates, isEmpty);
      expect(e.changes, isEmpty);
      expect(e.confirmationRequired, isFalse);
      expect(e.mode, EnvelopeMode.speak);
    }
  });

  test('ids follow the server\'s rule: positive whole numbers (zero, negative and fractional ids are dropped)', () {
    final e = ReplyEnvelope.fromReply(_reply(experience: _envelope(
      held: [{'id': 0}, {'id': -1}, {'id': 2.5}, {'id': 3}],
      candidates: [{'id': 0, 'name': 'Zero'}, {'id': -2, 'name': 'Neg'}, {'id': 4, 'name': 'Four'}],
    )))!;
    expect(e.heldActions.map((h) => h.id), [3]);
    expect(e.candidates.map((c) => c.id), [4]);
  });

  test('only a literal true means confirmation is required', () {
    for (final v in <Object?>[false, null, 'true', 1, 'yes']) {
      expect(ReplyEnvelope.fromReply(_reply(experience: _envelope(confirmationRequired: v)))!.confirmationRequired, isFalse, reason: '$v');
    }
    expect(ReplyEnvelope.fromReply(_reply(experience: _envelope(confirmationRequired: true)))!.confirmationRequired, isTrue);
  });

  test('a held action without a text type is still held (type null); one without an integer id is dropped', () {
    final e = ReplyEnvelope.fromReply(_reply(experience: _envelope(held: [{'id': 1}, {'id': 2, 'type': 5}, {'id': 'x', 'type': 'invoice'}])))!;
    expect(e.heldActions.map((h) => h.id), [1, 2]);
    expect(e.heldActions.map((h) => h.type), [null, null]);
  });

  test('lists are cut to 50 items and strings to 200 characters', () {
    final many = [for (var i = 0; i < 80; i++) {'id': i, 'type': 'invoice'}];
    expect(ReplyEnvelope.fromReply(_reply(experience: _envelope(held: many)))!.heldActions, hasLength(50));
    final long = 'x' * 500;
    final e = ReplyEnvelope.fromReply(_reply(experience: _envelope(speak: long, unknown: [long], held: [{'id': 1, 'type': long}])))!;
    expect(e.speak!.length, 200);
    expect(e.unknown.single.length, 200);
    expect(e.heldActions.single.type!.length, 200);
  });

  test('confirmable leaves out the actions shown as a choice between candidates', () {
    final e = ReplyEnvelope.fromReply(_reply(experience: _envelope(held: [
      {'id': 1, 'type': 'invoice'}, {'id': 2, 'type': 'project_ambiguity'}, {'id': 3, 'type': 'ambiguous_person'}, {'id': 4},
    ])))!;
    expect(e.heldActions, hasLength(4));
    expect(e.confirmable.map((h) => h.id), [1, 4]);
  });

  test('mayBeIncomplete is true only when the server names a malformed or cut-short reply field', () {
    expect(ReplyEnvelope.fromReply(_reply(experience: _envelope()))!.mayBeIncomplete, isFalse);
    expect(ReplyEnvelope.fromReply(_reply(experience: _envelope(unknown: ['room', 'reply_field_malformed:pendingChanges'])))!.mayBeIncomplete, isTrue);
    expect(ReplyEnvelope.fromReply(_reply(experience: _envelope(unknown: ['reply_field_truncated:pendingCandidates'])))!.mayBeIncomplete, isTrue);
  });

  test('fields the contract does not define (an address, a token, a permission) are ignored, not carried', () {
    final noisy = ReplyEnvelope.fromReply(_reply(experience: {
      ..._envelope(),
      'token': 'secret',
      'url': 'https://evil.example',
      'permissions': ['all'],
      'established': {'heldActions': [{'id': 12, 'type': 'invoice', 'url': 'https://evil.example', 'token': 'secret'}], 'extra': 'x'},
    }))!;
    final plain = ReplyEnvelope.fromReply(_reply(experience: {..._envelope(), 'established': {'heldActions': [{'id': 12, 'type': 'invoice'}]}}))!;
    expect(noisy.heldActions.single.id, plain.heldActions.single.id);
    expect(noisy.heldActions.single.type, plain.heldActions.single.type);
    expect(noisy.unknown, plain.unknown);
    expect(noisy.confirmationRequired, plain.confirmationRequired);
  });
}
