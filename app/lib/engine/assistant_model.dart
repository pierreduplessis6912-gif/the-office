// What the assistant screen reads from the engine's interpreter (POST /engine/interpret, GET /actions/pending and the confirm route) for everything built since the first slice: customers and suppliers, expenses and the VAT summary,
// and any held write (a new party, an expense; later a credit note and the rest). Backend contract: tools/engine-interpret-stack.test.js; the files in test/fixtures/slice named assistant-* are the engine's real answers, kept equal to
// the backend by tools/slice-mokoena.test.js, so the app and the engine cannot drift apart unseen.
//
// THE SCREEN COMPUTES NOTHING. A figure arrives as a whole number of minor units (or a total the ENGINE stamped on the held action) and is only formatted here; no total, tax, balance or status is worked out. Every reader is defensive:
// it never throws, returns an "unusable" turn for anything it does not understand, and bounds lists and text so a hostile or very large answer cannot make the app do unbounded work. No Flutter import, so it can be tested without a device.
import 'dart:convert';

import '../slice_model.dart' show randFromMinor;

const int _maxList = 50;
const int _maxText = 400;

String? _text(Object? v) => v is String ? (v.length > _maxText ? v.substring(0, _maxText) : v) : null;
int? _int(Object? v) {
  if (v is int) return v;
  if (v is double && v.isFinite && v == v.roundToDouble()) return v.toInt();
  return null;
}

Map<String, Object?>? _map(Object? v) => v is Map ? <String, Object?>{for (final e in v.entries) e.key.toString(): e.value} : null;
List<Object?> _list(Object? v) => v is List ? v.take(_maxList).toList() : const <Object?>[];

enum AssistantKind { parties, vat, expenses, held, ambiguous, notUnderstood, refused, unusable }

class AssistantParty {
  final int id;
  final String name;
  final String roles;
  const AssistantParty({required this.id, required this.name, required this.roles});
}

class AssistantVat {
  final String from;
  final String to;
  final int field1Minor;
  final int field4Minor;
  final int inputTaxMinor;
  final int netVatMinor;
  final bool locked;
  final int incompleteDocuments;
  final List<String> notes;
  const AssistantVat({required this.from, required this.to, required this.field1Minor, required this.field4Minor, required this.inputTaxMinor, required this.netVatMinor, required this.locked, required this.incompleteDocuments, required this.notes});
}

class AssistantExpense {
  final int id;
  final String supplier;
  final String category;
  final String incurredOn;
  final int grossMinor;
  final bool claimable;
  const AssistantExpense({required this.id, required this.supplier, required this.category, required this.incurredOn, required this.grossMinor, required this.claimable});
}

class AssistantTurn {
  final AssistantKind kind;
  final String? capability;
  final String? message;
  final int? actionId;
  final List<AssistantParty> parties;
  final AssistantVat? vat;
  final List<AssistantExpense> expenses;
  const AssistantTurn({required this.kind, this.capability, this.message, this.actionId, this.parties = const <AssistantParty>[], this.vat, this.expenses = const <AssistantExpense>[]});
  const AssistantTurn.unusable() : this(kind: AssistantKind.unusable);
}

List<AssistantParty> _parties(Object? v) {
  final out = <AssistantParty>[];
  for (final item in _list(v)) {
    final m = _map(item);
    final id = m == null ? null : _int(m['id']);
    final name = m == null ? null : _text(m['name']);
    if (m == null || id == null || name == null) continue;
    final roles = _list(m['roles']).whereType<String>().join(', ');
    out.add(AssistantParty(id: id, name: name, roles: roles));
  }
  return out;
}

/// Reads the answer of POST /engine/interpret. A read is shown as the engine's own answer; a write is HELD (nothing is recorded until it is confirmed); anything else is an honest refusal.
AssistantTurn parseInterpret(int status, Object? body) {
  final b = _map(body);
  if (b == null) return const AssistantTurn.unusable();
  if (status == 422 && b['error'] == 'not_understood') return AssistantTurn(kind: AssistantKind.notUnderstood, message: _text(b['message']));
  if (status != 200) return AssistantTurn(kind: AssistantKind.refused, message: _text(b['message']) ?? _text(b['error']) ?? 'That was not possible.');
  final understood = _map(b['understood']);
  final capability = understood == null ? null : _text(understood['capability']);
  if (b['status'] == 'held') {
    final id = _int(b['actionId']);
    if (id == null) return const AssistantTurn.unusable();
    return AssistantTurn(kind: AssistantKind.held, capability: capability, actionId: id, message: _text(b['message']));
  }
  if (b['status'] != 'ok') return const AssistantTurn.unusable();
  final r = _map(b['result']);
  if (r == null) return const AssistantTurn.unusable();
  if (capability == 'vat.summary') {
    final period = _map(r['period']);
    final f1 = _int(r['field1Minor']), f4 = _int(r['field4Minor']), input = _int(r['inputTaxMinor']), net = _int(r['netVatMinor']);
    final from = period == null ? null : _text(period['from']), to = period == null ? null : _text(period['to']);
    if (f1 == null || f4 == null || input == null || net == null || from == null || to == null) return const AssistantTurn.unusable();
    return AssistantTurn(kind: AssistantKind.vat, capability: capability, vat: AssistantVat(from: from, to: to, field1Minor: f1, field4Minor: f4, inputTaxMinor: input, netVatMinor: net, locked: r['locked'] == true, incompleteDocuments: _int(r['incompleteDocuments']) ?? 0, notes: _list(r['notes']).whereType<String>().map((n) => n.length > _maxText ? n.substring(0, _maxText) : n).toList()));
  }
  if (capability == 'expenses.find') {
    final rows = <AssistantExpense>[];
    for (final item in _list(r['expenses'])) {
      final m = _map(item);
      final id = m == null ? null : _int(m['id']);
      final gross = m == null ? null : _int(m['grossMinor']);
      if (m == null || id == null || gross == null) continue;
      rows.add(AssistantExpense(id: id, supplier: _text(m['supplierName']) ?? 'Supplier', category: _text(m['category']) ?? '', incurredOn: _text(m['incurredOn']) ?? '', grossMinor: gross, claimable: m['inputTaxClaimable'] == true));
    }
    return AssistantTurn(kind: AssistantKind.expenses, capability: capability, expenses: rows);
  }
  final parties = _parties(r['parties']);
  if (r['parties'] is List) {
    // finding parties answers a lookup; a list that came back because a NAME matched several people (a supplier or customer to choose from) is a question, not an answer
    return AssistantTurn(kind: capability == 'parties.find' ? AssistantKind.parties : AssistantKind.ambiguous, capability: capability, parties: parties);
  }
  return const AssistantTurn.unusable();
}

/// A write that is waiting for a person, read from GET /actions/pending.
class HeldAction {
  final int id;
  final String type;
  final Map<String, Object?> payload;
  final String transcript;
  const HeldAction({required this.id, required this.type, required this.payload, required this.transcript});
}

HeldAction? parseHeld(int status, Object? body, int actionId) {
  final b = _map(body);
  if (status != 200 || b == null) return null;
  for (final item in _list(b['pending'])) {
    final m = _map(item);
    if (m == null || _int(m['id']) != actionId) continue;
    final type = _text(m['type']);
    final raw = m['payload'];
    Map<String, Object?>? payload;
    if (raw is String) {
      try {
        payload = _map(jsonDecode(raw));
      } catch (_) {
        payload = null;
      }
    } else {
      payload = _map(raw);
    }
    if (type == null || payload == null) return null;
    return HeldAction(id: actionId, type: type, payload: payload, transcript: _text(m['source_transcript']) ?? '');
  }
  return null;
}

String heldTitle(String type) {
  switch (type) {
    case 'engine.party.create':
      return 'Add a customer or supplier';
    case 'engine.party.edit':
      return 'Change a customer or supplier';
    case 'engine.expense.record':
      return 'Record an expense';
    case 'engine.expense.void':
      return 'Void an expense';
    case 'engine.payment.record':
      return 'Record a payment';
    default:
      final bare = type.startsWith('engine.') ? type.substring(7) : type;
      return bare.replaceAll('_', ' ').replaceAll('.', ' ');
  }
}

class HeldLine {
  final String label;
  final String value;
  const HeldLine(this.label, this.value);
}

String _titleCase(String key) {
  final spaced = key.replaceAllMapped(RegExp(r'([a-z])([A-Z])'), (m) => '${m[1]} ${m[2]}');
  return spaced.isEmpty ? spaced : spaced[0].toUpperCase() + spaced.substring(1).toLowerCase();
}

String _yesNo(Object? v) => v == true ? 'Yes' : 'No';

/// What the approver would be approving, in lines. [names] maps a record number to the name the engine's own record read gave (the held payload holds only numbers). Money is formatted, never worked out: the totals are the ones the engine stamped.
List<HeldLine> heldLines(HeldAction a, {Map<int, String> names = const <int, String>{}}) {
  final p = a.payload;
  final currency = _text(p['currency']);
  String money(Object? v) {
    final n = _int(v);
    return n == null ? '' : randFromMinor(n, currency: currency);
  }

  final out = <HeldLine>[];
  if (a.type == 'engine.party.create') {
    final name = _text(p['name']);
    if (name != null) out.add(HeldLine('Name', name));
    final kind = _text(p['kind']);
    if (kind != null) out.add(HeldLine('Kind', kind));
    final roles = _list(p['roles']).whereType<String>().join(', ');
    if (roles.isNotEmpty) out.add(HeldLine('Role', roles));
    final contact = _map(p['contact']);
    if (contact != null) {
      for (final k in const <String>['email', 'phone', 'address', 'vatNumber']) {
        final v = _text(contact[k]);
        if (v != null) out.add(HeldLine(_titleCase(k), v));
      }
    }
    return out;
  }
  if (a.type == 'engine.expense.record') {
    final sid = _int(p['supplierId']);
    if (sid != null) out.add(HeldLine('Supplier', names[sid] ?? 'Supplier #$sid'));
    final cat = _text(p['category']);
    if (cat != null) out.add(HeldLine('Category', cat.replaceAll('_', ' ')));
    final date = _text(p['incurredOn']);
    if (date != null) out.add(HeldLine('Date', date));
    final method = _text(p['method']);
    if (method != null) out.add(HeldLine('Paid by', method));
    final paid = money(p['amountPaidMinor']);
    if (paid.isNotEmpty) out.add(HeldLine('Amount paid', paid));
    final totals = _map(p['totals']);
    if (totals != null) {
      final net = money(totals['netMinor']), tax = money(totals['taxMinor']), gross = money(totals['grossMinor']);
      if (net.isNotEmpty) out.add(HeldLine('Before tax', net));
      if (tax.isNotEmpty) out.add(HeldLine('Tax', tax));
      if (gross.isNotEmpty) out.add(HeldLine('Total', gross));
    }
    out.add(HeldLine('Tax invoice held', _yesNo(p['taxInvoiceHeld'])));
    return out;
  }
  // any other held write: its plain fields, money formatted; nothing is invented
  for (final e in p.entries) {
    final v = e.value;
    if (e.key == 'totals' || e.key == 'basedOn' || v is Map || v is List) continue;
    if (e.key.endsWith('Minor')) {
      final m = money(v);
      if (m.isNotEmpty) out.add(HeldLine(_titleCase(e.key.substring(0, e.key.length - 5)), m));
    } else if (v is String) {
      out.add(HeldLine(_titleCase(e.key), v.length > _maxText ? v.substring(0, _maxText) : v));
    } else if (v is bool) {
      out.add(HeldLine(_titleCase(e.key), _yesNo(v)));
    } else if (v is num) {
      out.add(HeldLine(_titleCase(e.key), v.toString()));
    }
  }
  return out;
}

/// The outcome of confirming or declining a held action.
class AssistantOutcome {
  final bool ok;
  final String message;
  const AssistantOutcome({required this.ok, required this.message});
}

AssistantOutcome parseDecision(int status, Object? body, {required bool confirmed}) {
  final b = _map(body);
  if (b == null) return const AssistantOutcome(ok: false, message: 'The Office did not answer that clearly.');
  if (status == 200) {
    return AssistantOutcome(ok: true, message: confirmed ? 'Done: it is now recorded.' : 'Declined: nothing was recorded.');
  }
  return AssistantOutcome(ok: false, message: _text(b['message']) ?? _text(b['error']) ?? 'That was not possible.');
}
