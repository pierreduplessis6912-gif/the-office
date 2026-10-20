// The reply envelope as a CONTRACT with the backend (ENVELOPE.md, version 1). tools/contract/envelope-v1.json is the one shared fixture: the
// backend's own test (tools/experience-contract.test.js) proves the Worker produces exactly the recorded envelopes for the recorded replies, and
// this test proves the app's reader reads those same recorded envelopes as the contract says. It also pins forward compatibility: extra fields are
// ignored, a version the app does not know is not read at all, and an unknown mode reads as speak, so a later, richer envelope cannot break this app.
// If this fails after a backend change, the envelope and the app have drifted: decide which is right, then re-record the fixture.
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:the_office/reply_envelope.dart';

Map<String, dynamic> _fixture() {
  for (final p in ['../tools/contract/envelope-v1.json', 'tools/contract/envelope-v1.json']) {
    final f = File(p);
    if (f.existsSync()) return jsonDecode(f.readAsStringSync()) as Map<String, dynamic>;
  }
  throw StateError('envelope-v1.json not found from ${Directory.current.path}');
}

void main() {
  final fx = _fixture();
  final cases = (fx['cases'] as List).cast<Map<String, dynamic>>();
  final compat = (fx['compatibility'] as List).cast<Map<String, dynamic>>();

  test('the shared fixture is found and has both kinds of entry', () {
    expect(cases.length, greaterThanOrEqualTo(10));
    expect(compat.length, greaterThanOrEqualTo(5));
  });

  for (final c in cases) {
    test('the backend envelope for "${c['name']}" is read as the contract says', () {
      final xp = c['experience'] as Map<String, dynamic>;
      final e = ReplyEnvelope.fromReply({'message': 'x', 'experience': xp});
      expect(e, isNotNull);
      final est = xp['established'] as Map<String, dynamic>;
      final rec = xp['recommendation'] as Map<String, dynamic>;
      final must = xp['mustStillPass'] as Map<String, dynamic>;
      final held = (est['heldActions'] as List).cast<Map<String, dynamic>>();
      final cands = ((est['candidates'] as List?) ?? const []).cast<Map<String, dynamic>>();
      final changes = ((est['changes'] as List?) ?? const []).cast<Map<String, dynamic>>();
      expect(e!.mode.name, rec['mode']);
      expect(e.speak, rec['speak']);
      expect(e.from, (est['from'] as List).cast<String>());
      expect(e.heldActions.map((h) => h.id).toList(), held.map((h) => h['id']).toList());
      expect(e.heldActions.map((h) => h.type).toList(), held.map((h) => h['type']).toList());
      expect(e.candidates.map((x) => [x.id, x.name]).toList(), cands.map((x) => [x['id'], x['name']]).toList());
      expect(e.changes.map((x) => [x.field, x.label, x.displayValue]).toList(), changes.map((x) => [x['field'], x['label'], x['displayValue']]).toList());
      expect(e.unknown, (xp['unknown'] as List).cast<String>());
      expect(e.confirmationRequired, must['confirmationRequired']);
    });
  }

  for (final c in compat) {
    test('compatibility: ${c['name']}', () {
      final expectation = c['expect'] as Map<String, dynamic>;
      final e = ReplyEnvelope.fromReply({'message': 'x', 'experience': c['experience']});
      if (expectation['read'] == false) {
        expect(e, isNull);
        return;
      }
      expect(e, isNotNull);
      expect(e!.mode.name, expectation['mode']);
      expect(e.heldActions.map((h) => h.id).toList(), (expectation['heldActionIds'] as List).cast<int>());
      expect(e.confirmationRequired, expectation['confirmationRequired']);
    });
  }
}
