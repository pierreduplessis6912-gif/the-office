// The Mokoena receivables slice: what the shell reads from the engine (/engine/receivables, /engine/records/:kind/:id, /engine/proposals and the confirm route) and the small state machine of the journey
// (question, answer, drill-down, back to the conversation, propose, approve). Backend contract: tools/slice-mokoena.test.js; the files in test/fixtures/slice are the engine's real answers, kept equal to the backend by that test.
//
// THE SHELL COMPUTES NOTHING. A figure arrives as a whole number of minor units and is only formatted here (randFromMinor); no balance, total or status is worked out in the app. Every reader is defensive: it never throws and returns
// an unusable result for anything it does not understand, and lists and text are bounded so a hostile or very large answer cannot make the app do unbounded work. This file has no Flutter import, so it can be tested without a device.
// What it does NOT do: it grants nothing (the engine decides what a member may see and do), it does not call the network, and it is not wired into main.dart yet.
import 'dart:convert';

const int _maxList = 50;
const int _maxText = 400;

String? _text(Object? v) => v is String ? (v.length > _maxText ? v.substring(0, _maxText) : v) : null;

int? _int(Object? v) {
  if (v is int) return v;
  if (v is double && v.isFinite && v == v.roundToDouble()) return v.toInt();
  return null;
}

Map<String, Object?>? _map(Object? v) {
  if (v is! Map) return null;
  return <String, Object?>{for (final e in v.entries) e.key.toString(): e.value};
}

List<Object?> _list(Object? v) => v is List ? v.take(_maxList).toList() : const <Object?>[];

/// Minor units to a display amount: 115000 and ZAR give "R1,150.00". Whole numbers only; the amount is never a decimal in the app.
String randFromMinor(int minor, {String? currency}) {
  final negative = minor < 0;
  final absolute = minor.abs();
  final digits = (absolute ~/ 100).toString();
  final grouped = StringBuffer();
  for (var i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 == 0) grouped.write(',');
    grouped.write(digits[i]);
  }
  final cents = (absolute % 100).toString().padLeft(2, '0');
  final prefix = (currency == null || currency == 'ZAR') ? 'R' : '$currency ';
  return '${negative ? '-' : ''}$prefix$grouped.$cents';
}

class SliceRef {
  final String kind;
  final int id;
  const SliceRef({required this.kind, required this.id});
}

SliceRef? _ref(Object? v) {
  final m = _map(v);
  if (m == null) return null;
  final kind = _text(m['kind']);
  final id = _int(m['id']);
  if (kind == null || kind.isEmpty || id == null || id < 1) return null;
  return SliceRef(kind: kind, id: id);
}

// ---- the answer to "what does Mokoena owe?" ----------------------------------------------------------------------------------------------------------------------------------------------------

class SliceLine {
  final SliceRef ref;
  final int? number;
  final String kind;
  final String issuedOn;
  final int grossMinor;
  final int allocatedMinor;
  final int outstandingMinor;
  const SliceLine({required this.ref, required this.number, required this.kind, required this.issuedOn, required this.grossMinor, required this.allocatedMinor, required this.outstandingMinor});
}

class SliceAnswer {
  final int partyId;
  final String partyName;
  final String currency;
  final int totalMinor;
  final List<SliceLine> lines;
  final int version;
  final String derivedBy;
  const SliceAnswer({required this.partyId, required this.partyName, required this.currency, required this.totalMinor, required this.lines, required this.version, required this.derivedBy});

  String get totalText => randFromMinor(totalMinor, currency: currency);
}

class SliceCandidate {
  final int id;
  final String name;
  const SliceCandidate({required this.id, required this.name});
}

enum SliceReadKind { answer, ambiguous, refused, notFound, unavailable, unusable }

class SliceRead {
  final SliceReadKind kind;
  final SliceAnswer? answer;
  final List<SliceCandidate> candidates;
  final String? message;
  const SliceRead._(this.kind, this.answer, this.candidates, [this.message]);
  const SliceRead.answer(SliceAnswer a) : this._(SliceReadKind.answer, a, const <SliceCandidate>[]);
  const SliceRead.ambiguous(List<SliceCandidate> c) : this._(SliceReadKind.ambiguous, null, c);
  const SliceRead.refused() : this._(SliceReadKind.refused, null, const <SliceCandidate>[]);
  const SliceRead.notFound() : this._(SliceReadKind.notFound, null, const <SliceCandidate>[]);

  /// This business does not have the capability. The engine says so in its own words and nothing else; the reader never looks for a figure.
  const SliceRead.unavailable(String? m) : this._(SliceReadKind.unavailable, null, const <SliceCandidate>[], m);
  const SliceRead.unusable() : this._(SliceReadKind.unusable, null, const <SliceCandidate>[]);
}

SliceLine? _line(Object? v) {
  final m = _map(v);
  if (m == null) return null;
  final ref = _ref(m['ref']);
  final kind = _text(m['kind']);
  final issuedOn = _text(m['issuedOn']);
  final gross = _int(m['grossMinor']);
  final allocated = _int(m['allocatedMinor']);
  final outstanding = _int(m['outstandingMinor']);
  if (ref == null || kind == null || issuedOn == null || gross == null || allocated == null || outstanding == null) return null;
  return SliceLine(ref: ref, number: _int(m['number']), kind: kind, issuedOn: issuedOn, grossMinor: gross, allocatedMinor: allocated, outstandingMinor: outstanding);
}

/// Reads the answer of GET /engine/receivables. [status] is the HTTP status, [body] the decoded JSON. A refusal (403) and a missing customer (404) carry no figure and the reader never looks for one.
SliceRead parseReceivables(int status, Object? body) {
  if (status == 403) return const SliceRead.refused();
  if (status == 404) return const SliceRead.notFound();
  if (status == 409) {
    final conflict = _map(body);
    if (conflict != null && conflict['error'] == 'capability_unavailable') return SliceRead.unavailable(_text(conflict['message']));
    return const SliceRead.unusable();
  }
  final b = _map(body);
  if (status != 200 || b == null) return const SliceRead.unusable();
  if (b['status'] == 'ambiguous') {
    final out = <SliceCandidate>[];
    for (final c in _list(b['candidates'])) {
      final m = _map(c);
      final id = m == null ? null : _int(m['id']);
      final name = m == null ? null : _text(m['name']);
      if (id == null || name == null) return const SliceRead.unusable();
      out.add(SliceCandidate(id: id, name: name));
    }
    return out.length < 2 ? const SliceRead.unusable() : SliceRead.ambiguous(out);
  }
  if (b['status'] != 'ok') return const SliceRead.unusable();
  final r = _map(b['result']);
  final party = r == null ? null : _map(r['party']);
  if (r == null || party == null) return const SliceRead.unusable();
  final partyId = _int(party['id']);
  final partyName = _text(party['name']);
  final total = _int(r['totalMinor']);
  final version = _int(r['version']);
  final derivedBy = _text(r['derivedBy']);
  final currency = r['currency'] == null ? 'ZAR' : _text(r['currency']);
  if (partyId == null || partyName == null || total == null || version == null || derivedBy == null || currency == null || r['documents'] is! List) return const SliceRead.unusable();
  final lines = <SliceLine>[];
  for (final d in _list(r['documents'])) {
    final line = _line(d);
    if (line == null) return const SliceRead.unusable();
    lines.add(line);
  }
  return SliceRead.answer(SliceAnswer(partyId: partyId, partyName: partyName, currency: currency, totalMinor: total, lines: lines, version: version, derivedBy: derivedBy));
}

// ---- a record opened from the answer (GET /engine/records/:kind/:id) -----------------------------------------------------------------------------------------------------------------------------

class SliceField {
  final String key;
  final String label;
  final String display;
  final String? derivedBy;
  const SliceField({required this.key, required this.label, required this.display, required this.derivedBy});
}

class SliceRelation {
  final String role;
  final SliceRef ref;
  final String label;
  const SliceRelation({required this.role, required this.ref, required this.label});
}

class SliceAction {
  final String capability;
  final String label;
  final bool valid;
  final String? reason;
  const SliceAction({required this.capability, required this.label, required this.valid, required this.reason});
}

class SliceHistoryEntry {
  final int eventId;
  final String type;
  final String at;
  final String? actor;
  final String? reason;

  /// The provenance (invariant 6): the capture (what was said), the proposal and the approver behind this fact, and the contract that executed it. Null where the fact was written without a proposal (a seeded or system-generated record); never invented.
  final int? captureId;
  final int? proposalId;
  final String? approvedBy;
  final String? contract;
  final int? contractVersion;

  /// What was understood: the interpretation that linked the capture to the proposal, and who interpreted ('script' or 'model'). Null where there was no proposal.
  final int? interpretationId;
  final String? interpreter;
  const SliceHistoryEntry({required this.eventId, required this.type, required this.at, required this.actor, required this.reason, this.captureId, this.proposalId, this.approvedBy, this.contract, this.contractVersion, this.interpretationId, this.interpreter});

  /// True when a proposal and an approver stand behind this fact.
  bool get hasTrail => proposalId != null && approvedBy != null;
}

class SliceRecord {
  final SliceRef ref;
  final int version;
  final String title;
  final List<SliceField> fields;
  final Map<String, List<Map<String, Object?>>> collections;
  final List<SliceRelation> relations;
  final List<SliceAction> actions;
  final List<SliceHistoryEntry> history;
  const SliceRecord({required this.ref, required this.version, required this.title, required this.fields, required this.collections, required this.relations, required this.actions, required this.history});
}

/// Reads a record view. Null for anything that is not an ok, usable view: a record the member may not see answers exactly as one that does not exist, so the app cannot tell the two apart and does not try.
SliceRecord? parseRecord(int status, Object? body) {
  final b = _map(body);
  if (status != 200 || b == null || b['status'] != 'ok') return null;
  final r = _map(b['result']);
  if (r == null) return null;
  final ref = _ref(r['ref']);
  final version = _int(r['version']);
  final title = _text(r['title']);
  if (ref == null || version == null || title == null) return null;
  String? currency;
  for (final f in _list(r['fields'])) {
    final m = _map(f);
    if (m != null && m['key'] == 'currency') currency = _text(m['value']);
  }
  final fields = <SliceField>[];
  for (final f in _list(r['fields'])) {
    final m = _map(f);
    final key = m == null ? null : _text(m['key']);
    final label = m == null ? null : _text(m['label']);
    if (m == null || key == null || label == null) continue;
    final value = m['value'];
    final minor = _int(value);
    final display = key.endsWith('Minor') && minor != null ? randFromMinor(minor, currency: currency) : (value == null ? '' : (_text(value is String ? value : value.toString()) ?? ''));
    fields.add(SliceField(key: key, label: label, display: display, derivedBy: _text(m['derivedBy'])));
  }
  final collections = <String, List<Map<String, Object?>>>{};
  final rawCollections = _map(r['collections']);
  if (rawCollections != null) {
    for (final e in rawCollections.entries.take(_maxList)) {
      final rows = <Map<String, Object?>>[];
      for (final row in _list(e.value)) {
        final m = _map(row);
        if (m != null) rows.add(m);
      }
      collections[e.key] = rows;
    }
  }
  final relations = <SliceRelation>[];
  for (final x in _list(r['relations'])) {
    final m = _map(x);
    final role = m == null ? null : _text(m['role']);
    final rel = m == null ? null : _ref(m['ref']);
    final label = m == null ? null : _text(m['label']);
    if (role != null && rel != null && label != null) relations.add(SliceRelation(role: role, ref: rel, label: label));
  }
  final actions = <SliceAction>[];
  for (final x in _list(r['actions'])) {
    final m = _map(x);
    final capability = m == null ? null : _text(m['capability']);
    final label = m == null ? null : _text(m['label']);
    if (m != null && capability != null && label != null && m['valid'] is bool) actions.add(SliceAction(capability: capability, label: label, valid: m['valid'] as bool, reason: _text(m['reason'])));
  }
  final history = <SliceHistoryEntry>[];
  for (final x in _list(r['history'])) {
    final m = _map(x);
    final eventId = m == null ? null : _int(m['eventId']);
    final type = m == null ? null : _text(m['type']);
    final at = m == null ? null : _text(m['at']);
    if (m != null && eventId != null && type != null && at != null) {
      history.add(SliceHistoryEntry(
        eventId: eventId,
        type: type,
        at: at,
        actor: _text(m['actor']),
        reason: _text(m['reason']),
        captureId: _int(m['captureId']),
        proposalId: _int(m['proposalId']),
        approvedBy: _text(m['approvedBy']),
        contract: _text(m['contract']),
        contractVersion: _int(m['contractVersion']),
        interpretationId: _int(m['interpretationId']),
        interpreter: _text(m['interpreter']),
      ));
    }
  }
  return SliceRecord(ref: ref, version: version, title: title, fields: fields, collections: collections, relations: relations, actions: actions, history: history);
}

// ---- stage two: a proposal is held, then approved -------------------------------------------------------------------------------------------------------------------------------------------------

class SliceProposal {
  final bool held;
  final int? actionId;
  final String? error;
  final String? message;
  const SliceProposal({required this.held, this.actionId, this.error, this.message});
}

/// Reads the answer of POST /engine/proposals. Held means HELD for approval: nothing is recorded yet.
SliceProposal parseProposal(int status, Object? body) {
  final b = _map(body);
  if (b == null) return const SliceProposal(held: false, error: 'unusable');
  final actionId = _int(b['actionId']);
  if (status == 200 && b['status'] == 'held' && actionId != null) return SliceProposal(held: true, actionId: actionId, message: _text(b['message']));
  return SliceProposal(held: false, error: _text(b['error']) ?? 'unusable', message: _text(b['message']));
}

/// A payment waiting for approval, read from GET /actions/pending. It names the customer and the invoices only by number (partyId, documentId): an approval card that shows names, the document type and the total (audit decision D2)
/// must read them through permission-checked record reads, or from a server projection that does not exist yet. The allocations are the EXACT ones the approver is approving, and partyVersion is the account version they were based on.
class SliceHeldAllocation {
  final int documentId;
  final int amountMinor;
  const SliceHeldAllocation({required this.documentId, required this.amountMinor});
}

class SliceHeldPayment {
  final int actionId;
  final String transcript;
  final int partyId;
  final int amountMinor;
  final String currency;
  final String occurredOn;
  final List<SliceHeldAllocation> allocations;
  final int? partyVersion;
  const SliceHeldPayment({required this.actionId, required this.transcript, required this.partyId, required this.amountMinor, required this.currency, required this.occurredOn, required this.allocations, required this.partyVersion});

  String get amountText => randFromMinor(amountMinor, currency: currency);
}

/// Reads the engine's held payments out of GET /actions/pending (other kinds of held action are ignored; anything unusable is skipped).
List<SliceHeldPayment> parseHeldPayments(int status, Object? body) {
  final b = _map(body);
  if (status != 200 || b == null) return const <SliceHeldPayment>[];
  final out = <SliceHeldPayment>[];
  for (final item in _list(b['pending'])) {
    final m = _map(item);
    if (m == null || m['type'] != 'engine.payment.record') continue;
    final id = _int(m['id']);
    final raw = m['payload'];
    if (id == null || raw is! String) continue;
    Object? decoded;
    try {
      decoded = jsonDecode(raw);
    } catch (_) {
      continue;
    }
    final p = _map(decoded);
    if (p == null) continue;
    final partyId = _int(p['partyId']);
    final amount = _int(p['amountMinor']);
    final currency = _text(p['currency']);
    final occurredOn = _text(p['occurredOn']);
    if (partyId == null || amount == null || currency == null || occurredOn == null || p['allocations'] is! List) continue;
    final allocations = <SliceHeldAllocation>[];
    var usable = true;
    for (final a in _list(p['allocations'])) {
      final am = _map(a);
      final documentId = am == null ? null : _int(am['documentId']);
      final allocated = am == null ? null : _int(am['amountMinor']);
      if (documentId == null || allocated == null) {
        usable = false;
        break;
      }
      allocations.add(SliceHeldAllocation(documentId: documentId, amountMinor: allocated));
    }
    if (!usable) continue;
    final basedOn = _map(p['basedOn']);
    out.add(SliceHeldPayment(actionId: id, transcript: _text(m['source_transcript']) ?? '', partyId: partyId, amountMinor: amount, currency: currency, occurredOn: occurredOn, allocations: allocations, partyVersion: basedOn == null ? null : _int(basedOn['partyVersion'])));
  }
  return out;
}

class SliceConfirm {
  final bool ok;
  final String? error;
  final String? message;
  const SliceConfirm({required this.ok, this.error, this.message});

  /// The account changed after the proposal: an approval is only ever for what it showed, so the person must look again and propose again.
  bool get stale => error == 'stale';
}

/// Reads the answer of POST /actions/:id/confirm.
SliceConfirm parseConfirm(int status, Object? body) {
  final b = _map(body);
  if (b == null) return const SliceConfirm(ok: false, error: 'unusable');
  if (status == 200 && b['status'] == 'confirmed') return const SliceConfirm(ok: true);
  return SliceConfirm(ok: false, error: _text(b['error']) ?? 'unusable', message: _text(b['message']));
}

class SliceReject {
  final bool ok;
  final String? error;
  final String? message;
  const SliceReject({required this.ok, this.error, this.message});
}

/// Reads the answer of POST /actions/<id>/reject. Declined means nothing was recorded and nothing waits any more. The engine's refusals here use the older shape {error: "..."} (the error text is the message).
SliceReject parseReject(int status, Object? body) {
  final b = _map(body);
  if (b == null) return const SliceReject(ok: false, error: 'unusable');
  if (status == 200 && b['status'] == 'rejected') return const SliceReject(ok: true);
  final error = _text(b['error']);
  return SliceReject(ok: false, error: error ?? 'unusable', message: _text(b['message']) ?? error);
}

// ---- the journey -----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

enum SliceStep { resting, asking, answered, ambiguous, refused, unavailable, record, held, approving, done, problem }

/// Where the person is in the journey. Immutable: every transition returns a new flow, and a transition that does not make sense from where the person is returns the same flow unchanged, so a late or repeated answer cannot move the screen somewhere wrong.
class SliceFlow {
  final SliceStep step;
  final SliceAnswer? answer;
  final List<SliceCandidate> candidates;
  final SliceRecord? record;
  final int? actionId;
  final String? message;
  final bool needsRefresh;
  const SliceFlow._({required this.step, this.answer, this.candidates = const <SliceCandidate>[], this.record, this.actionId, this.message, this.needsRefresh = false});

  const SliceFlow.resting() : this._(step: SliceStep.resting);

  /// The orb's phase for this step: idle, thinking, responding, awaiting (a decision is waiting on the person) or executing.
  String get orbPhase {
    switch (step) {
      case SliceStep.resting:
      case SliceStep.problem:
        return 'idle';
      case SliceStep.asking:
        return 'thinking';
      case SliceStep.held:
        return 'awaiting';
      case SliceStep.approving:
        return 'executing';
      case SliceStep.answered:
      case SliceStep.ambiguous:
      case SliceStep.refused:
      case SliceStep.unavailable:
      case SliceStep.record:
      case SliceStep.done:
        return 'responding';
    }
  }

  SliceFlow asked() => const SliceFlow._(step: SliceStep.asking);

  SliceFlow received(SliceRead read) {
    if (step != SliceStep.asking) return this;
    switch (read.kind) {
      case SliceReadKind.answer:
        return SliceFlow._(step: SliceStep.answered, answer: read.answer);
      case SliceReadKind.ambiguous:
        return SliceFlow._(step: SliceStep.ambiguous, candidates: read.candidates);
      case SliceReadKind.refused:
        return const SliceFlow._(step: SliceStep.refused);
      case SliceReadKind.unavailable:
        return SliceFlow._(step: SliceStep.unavailable, message: read.message ?? 'This is not available for this business.');
      case SliceReadKind.notFound:
        return const SliceFlow._(step: SliceStep.problem, message: 'There is no such customer.');
      case SliceReadKind.unusable:
        return const SliceFlow._(step: SliceStep.problem, message: 'That answer could not be read.');
    }
  }

  /// A record opened from the answer. Only possible from an answer (or from another record opened from it).
  SliceFlow opened(SliceRecord rec) {
    if (answer == null || (step != SliceStep.answered && step != SliceStep.record)) return this;
    return SliceFlow._(step: SliceStep.record, answer: answer, record: rec);
  }

  /// Back to the conversation: the answer stays on screen, the record is closed.
  SliceFlow backToConversation() {
    if (step != SliceStep.record || answer == null) return this;
    return SliceFlow._(step: SliceStep.answered, answer: answer);
  }

  /// A payment proposal came back. Held means waiting for the person's approval; anything else is a problem that says why.
  SliceFlow proposed(SliceProposal p) {
    if (answer == null || (step != SliceStep.answered && step != SliceStep.record)) return this;
    if (p.held && p.actionId != null) return SliceFlow._(step: SliceStep.held, answer: answer, actionId: p.actionId, message: p.message);
    return SliceFlow._(step: SliceStep.problem, answer: answer, message: p.message ?? 'The payment could not be proposed.');
  }

  /// A held payment was declined: back to the answer, nothing recorded. A refused decline leaves the payment held, because it still waits.
  SliceFlow declined(SliceReject r) {
    if (step != SliceStep.held || !r.ok) return this;
    return SliceFlow._(step: SliceStep.answered, answer: answer);
  }

  SliceFlow approving() {
    if (step != SliceStep.held) return this;
    return SliceFlow._(step: SliceStep.approving, answer: answer, actionId: actionId);
  }

  /// The approval came back. Done means recorded; a stale approval asks the person to look again (needsRefresh), and any other refusal says why.
  SliceFlow confirmed(SliceConfirm c) {
    if (step != SliceStep.approving) return this;
    if (c.ok) return SliceFlow._(step: SliceStep.done, answer: answer, actionId: actionId);
    return SliceFlow._(step: SliceStep.problem, answer: answer, message: c.message ?? 'The payment was not recorded.', needsRefresh: c.stale);
  }
}
