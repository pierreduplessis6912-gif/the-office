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

enum AssistantKind { parties, vat, expenses, held, ambiguous, notUnderstood, refused, captured, unusable }

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
  // A voice note, photo or document that was KEPT (and perhaps read or heard) but not turned into anything: said plainly, nothing was done with it.
  if (b['status'] == 'captured') return AssistantTurn(kind: AssistantKind.captured, message: _text(b['message']) ?? 'Saved. Nothing was done with it.');
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

/// The expenses the engine listed (GET /engine/expenses). Null when the answer cannot be read at all; a row that cannot be read is left out, nothing is guessed.
List<AssistantExpense>? parseExpenseList(int status, Object? body) {
  final b = _map(body);
  if (status != 200 || b == null || b['status'] != 'ok') return null;
  final r = _map(b['result']);
  if (r == null || r['expenses'] is! List) return null;
  final rows = <AssistantExpense>[];
  for (final item in _list(r['expenses'])) {
    final m = _map(item);
    final id = m == null ? null : _int(m['id']);
    final gross = m == null ? null : _int(m['grossMinor']);
    if (m == null || id == null || gross == null) continue;
    rows.add(AssistantExpense(id: id, supplier: _text(m['supplierName']) ?? 'Supplier', category: _text(m['category']) ?? '', incurredOn: _text(m['incurredOn']) ?? '', grossMinor: gross, claimable: m['inputTaxClaimable'] == true));
  }
  return rows;
}

/// Every engine action waiting for a person, in the order the engine gave them. An action that is not the engine's (a legacy one) or cannot be read is left out: nothing is guessed.
List<HeldAction> parseHeldList(int status, Object? body) {
  final b = _map(body);
  if (status != 200 || b == null) return const <HeldAction>[];
  final out = <HeldAction>[];
  for (final item in _list(b['pending'])) {
    final m = _map(item);
    final id = m == null ? null : _int(m['id']);
    final type = m == null ? null : _text(m['type']);
    if (id == null || type == null || !type.startsWith('engine.')) continue;
    final held = parseHeld(status, body, id);
    if (held != null) out.add(held);
  }
  return out;
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
    case 'engine.supplier_invoice.record':
      return 'Record a supplier bill';
    case 'engine.payment.record':
      return 'Record a payment';
    case 'engine.supplier_payment.record':
      return 'Pay a supplier';
    case 'engine.payment.refund':
      return 'Refund an overpayment';
    case 'engine.refund.record':
      return 'Refund credit';
    case 'engine.quotation.create':
      return 'Make a quotation';
    case 'engine.invoice.issue':
      return 'Issue an invoice';
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
  if (a.type == 'engine.payment.record' || a.type == 'engine.supplier_payment.record') {
    final supplierSide = a.type == 'engine.supplier_payment.record';
    final id = _int(p[supplierSide ? 'supplierId' : 'partyId']);
    if (id != null) out.add(HeldLine(supplierSide ? 'Supplier' : 'Customer', names[id] ?? '${supplierSide ? 'Supplier' : 'Customer'} #$id'));
    final amount = money(p['amountMinor']);
    if (amount.isNotEmpty) out.add(HeldLine('Amount', amount));
    final date = _text(p[supplierSide ? 'paidOn' : 'occurredOn']);
    if (date != null) out.add(HeldLine('Date', date));
    final method = _text(p['method']);
    if (method != null) out.add(HeldLine('Paid by', method));
    final account = _int(p['bankAccountId']);
    if (account != null) out.add(HeldLine('Bank account', 'Account #$account'));
    if (p['allocate'] == 'oldest_first') out.add(HeldLine('Settles', supplierSide ? 'Oldest bills first' : 'Oldest invoices first'));
    return out;
  }
  if (a.type == 'engine.payment.refund' || a.type == 'engine.refund.record') {
    final credit = a.type == 'engine.refund.record';
    final id = _int(p[credit ? 'creditNoteId' : 'paymentId']);
    if (id != null) out.add(HeldLine(credit ? 'Credit note' : 'Payment', '${credit ? 'Credit note' : 'Payment'} #$id'));
    final amount = money(p['amountMinor']);
    if (amount.isNotEmpty) out.add(HeldLine('Refund', amount));
    final date = _text(p['refundedOn']);
    if (date != null) out.add(HeldLine('Date', date));
    final method = _text(p['method']);
    if (method != null) out.add(HeldLine('Paid back by', method));
    final account = _int(p['bankAccountId']);
    if (account != null) out.add(HeldLine('Bank account', 'Account #$account'));
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

/// One stock item as the engine reports it. Quantities are in thousandths of the unit; the value is null when the person may not see money.
class AssistantStockRow {
  final int id;
  final String name;
  final String unit;
  final int quantityMilli;
  final int reservedMilli;
  final int availableMilli;
  final bool belowReorder;
  final int? valueMinor;
  const AssistantStockRow({required this.id, required this.name, required this.unit, required this.quantityMilli, required this.reservedMilli, required this.availableMilli, required this.belowReorder, required this.valueMinor});
}

/// A quantity in thousandths as a plain number: 12000 is "12", 2500 is "2.5".
String quantityFromMilli(int milli) {
  final whole = milli ~/ 1000;
  final frac = (milli.abs() % 1000).toString().padLeft(3, '0').replaceFirst(RegExp(r'0+$'), '');
  final sign = milli < 0 && whole == 0 ? '-' : '';
  return frac.isEmpty ? '$whole' : '$sign$whole.$frac';
}

/// The stock the engine listed, or null when the answer cannot be read. A row without its figures is left out; nothing is guessed.
List<AssistantStockRow>? parseStockList(int status, Object? body) {
  final b = _map(body);
  if (status != 200 || b == null || b['status'] != 'ok') return null;
  final r = _map(b['result']);
  if (r == null || r['stock'] is! List) return null;
  final rows = <AssistantStockRow>[];
  for (final item in _list(r['stock'])) {
    final m = _map(item);
    final id = m == null ? null : _int(m['itemId']);
    final q = m == null ? null : _int(m['quantityMilli']);
    if (m == null || id == null || q == null) continue;
    rows.add(AssistantStockRow(id: id, name: _text(m['name']) ?? 'Item', unit: _text(m['unit']) ?? '', quantityMilli: q, reservedMilli: _int(m['reservedMilli']) ?? 0, availableMilli: _int(m['availableMilli']) ?? q, belowReorder: m['belowReorder'] == true, valueMinor: _int(m['valueMinor'])));
  }
  return rows;
}

/// One supplier bill as the engine reports it, in the engine's own figures.
class AssistantBill {
  final int id;
  final String supplier;
  final String invoiceNumber;
  final String dueOn;
  final int grossMinor;
  final int outstandingMinor;
  final String status;
  const AssistantBill({required this.id, required this.supplier, required this.invoiceNumber, required this.dueOn, required this.grossMinor, required this.outstandingMinor, required this.status});
}

/// The bills the engine listed, or null when the answer cannot be read. A row without its figures is left out; nothing is guessed.
List<AssistantBill>? parseBillList(int status, Object? body) {
  final b = _map(body);
  if (status != 200 || b == null || b['status'] != 'ok') return null;
  final r = _map(b['result']);
  if (r == null || r['bills'] is! List) return null;
  final rows = <AssistantBill>[];
  for (final item in _list(r['bills'])) {
    final m = _map(item);
    final id = m == null ? null : _int(m['id']);
    final gross = m == null ? null : _int(m['grossMinor']);
    final owing = m == null ? null : _int(m['outstandingMinor']);
    if (m == null || id == null || gross == null || owing == null) continue;
    rows.add(AssistantBill(id: id, supplier: _text(m['supplierName']) ?? 'Supplier', invoiceNumber: _text(m['supplierInvoiceNumber']) ?? '', dueOn: _text(m['dueOn']) ?? '', grossMinor: gross, outstandingMinor: owing, status: _text(m['status']) ?? ''));
  }
  return rows;
}

/// One purchase order as the engine reports it, in the engine's own figures.
class AssistantOrder {
  final int id;
  final int? number;
  final String supplier;
  final String orderedOn;
  final String expectedOn;
  final int grossMinor;
  final String status;
  const AssistantOrder({required this.id, required this.number, required this.supplier, required this.orderedOn, required this.expectedOn, required this.grossMinor, required this.status});
}

/// The purchase orders the engine listed, or null when the answer cannot be read. A row without its figures is left out; nothing is guessed.
List<AssistantOrder>? parseOrderList(int status, Object? body) {
  final b = _map(body);
  if (status != 200 || b == null || b['status'] != 'ok') return null;
  final r = _map(b['result']);
  if (r == null || r['orders'] is! List) return null;
  final rows = <AssistantOrder>[];
  for (final item in _list(r['orders'])) {
    final m = _map(item);
    final id = m == null ? null : _int(m['id']);
    final gross = m == null ? null : _int(m['grossMinor']);
    if (m == null || id == null || gross == null) continue;
    rows.add(AssistantOrder(id: id, number: _int(m['number']), supplier: _text(m['supplierName']) ?? 'Supplier', orderedOn: _text(m['orderedOn']) ?? '', expectedOn: _text(m['expectedOn']) ?? '', grossMinor: gross, status: _text(m['status']) ?? ''));
  }
  return rows;
}

/// One quotation as the engine reports it, in the engine's own figures.
class AssistantQuote {
  final int id;
  final int? number;
  final String customer;
  final String issuedOn;
  final String validUntil;
  final int grossMinor;
  final String status;
  const AssistantQuote({required this.id, required this.number, required this.customer, required this.issuedOn, required this.validUntil, required this.grossMinor, required this.status});
}

/// The quotations the engine listed, or null when the answer cannot be read. A row without its figures is left out; nothing is guessed.
List<AssistantQuote>? parseQuoteList(int status, Object? body) {
  final b = _map(body);
  if (status != 200 || b == null || b['status'] != 'ok') return null;
  final r = _map(b['result']);
  if (r == null || r['quotations'] is! List) return null;
  final rows = <AssistantQuote>[];
  for (final item in _list(r['quotations'])) {
    final m = _map(item);
    final id = m == null ? null : _int(m['id']);
    final gross = m == null ? null : _int(m['grossMinor']);
    if (m == null || id == null || gross == null) continue;
    rows.add(AssistantQuote(id: id, number: _int(m['number']), customer: _text(m['partyName']) ?? 'Customer', issuedOn: _text(m['issuedOn']) ?? '', validUntil: _text(m['validUntil']) ?? '', grossMinor: gross, status: _text(m['status']) ?? ''));
  }
  return rows;
}

class InvoiceEntry {
  final int id;
  final int? number;
  final String customer;
  final String issuedOn;
  final int grossMinor;
  final int outstandingMinor;
  const InvoiceEntry({required this.id, required this.number, required this.customer, required this.issuedOn, required this.grossMinor, required this.outstandingMinor});
}

class InvoiceList {
  final List<InvoiceEntry> rows;
  final int owingMinor;
  final bool truncated;
  const InvoiceList(this.rows, this.owingMinor, this.truncated);
}

/// The invoices the engine listed, or null when the answer cannot be read. A row without its figures is left out; the total owing is the engine's.
InvoiceList? parseInvoiceList(int status, Object? body) {
  final b = _map(body);
  if (status != 200 || b == null || b['status'] != 'ok') return null;
  final r = _map(b['result']);
  if (r == null || r['invoices'] is! List) return null;
  final rows = <InvoiceEntry>[];
  for (final item in _list(r['invoices'])) {
    final m = _map(item);
    final id = m == null ? null : _int(m['id']);
    final gross = m == null ? null : _int(m['grossMinor']);
    final out = m == null ? null : _int(m['outstandingMinor']);
    if (m == null || id == null || gross == null || out == null) continue;
    rows.add(InvoiceEntry(id: id, number: _int(m['number']), customer: _text(m['partyName']) ?? 'Customer', issuedOn: _text(m['issuedOn']) ?? '', grossMinor: gross, outstandingMinor: out));
  }
  final owing = _int(r['owingMinor']);
  if (owing == null) return null;
  return InvoiceList(rows, owing, r['truncated'] == true);
}

/// One customer or supplier as the engine reports it.
class PartyEntry {
  final int id;
  final String name;
  final List<String> roles;
  final String email;
  final String phone;
  const PartyEntry({required this.id, required this.name, required this.roles, required this.email, required this.phone});

  bool get isCustomer => roles.contains('customer');
}

/// The parties the engine listed, or null when the answer cannot be read. A row without an id or a name is left out; nothing is guessed.
List<PartyEntry>? parsePartyList(int status, Object? body) {
  final b = _map(body);
  if (status != 200 || b == null || b['status'] != 'ok') return null;
  final r = _map(b['result']);
  if (r == null || r['parties'] is! List) return null;
  final rows = <PartyEntry>[];
  for (final item in _list(r['parties'])) {
    final m = _map(item);
    final id = m == null ? null : _int(m['id']);
    final name = m == null ? null : _text(m['name']);
    if (m == null || id == null || name == null) continue;
    final contact = _map(m['contact']);
    rows.add(PartyEntry(id: id, name: name, roles: <String>[for (final x in _list(m['roles'])) if (_text(x) != null) _text(x)!], email: contact == null ? '' : (_text(contact['email']) ?? ''), phone: contact == null ? '' : (_text(contact['phone']) ?? '')));
  }
  return rows;
}

/// One account line on a report: a name and an amount in the engine's own minor units.
class BookLine {
  final String name;
  final int amountMinor;
  const BookLine(this.name, this.amountMinor);
}

class BookProfit {
  final String from;
  final String to;
  final List<BookLine> income;
  final List<BookLine> costOfSales;
  final List<BookLine> expenses;
  final int incomeMinor;
  final int grossProfitMinor;
  final int profitMinor;
  const BookProfit({required this.from, required this.to, required this.income, required this.costOfSales, required this.expenses, required this.incomeMinor, required this.grossProfitMinor, required this.profitMinor});
}

class BookBalance {
  final String asOf;
  final List<BookLine> assets;
  final List<BookLine> liabilities;
  final List<BookLine> equity;
  final int earningsMinor;
  final int assetsMinor;
  final bool balanced;
  const BookBalance({required this.asOf, required this.assets, required this.liabilities, required this.equity, required this.earningsMinor, required this.assetsMinor, required this.balanced});
}

class BookCheck {
  final String label;
  final int differenceMinor;
  const BookCheck(this.label, this.differenceMinor);
}

class BookReconciliation {
  final List<BookCheck> checks;
  final bool agrees;
  const BookReconciliation(this.checks, this.agrees);
}

List<BookLine> _bookLines(Object? v) {
  final out = <BookLine>[];
  for (final item in _list(v)) {
    final m = _map(item);
    final amount = m == null ? null : _int(m['amountMinor']);
    if (m == null || amount == null) continue;
    out.add(BookLine(_text(m['name']) ?? 'Account', amount));
  }
  return out;
}

Map<String, Object?>? _bookResult(int status, Object? body) {
  final b = _map(body);
  if (status != 200 || b == null || b['status'] != 'ok') return null;
  return _map(b['result']);
}

BookProfit? parseProfit(int status, Object? body) {
  final r = _bookResult(status, body);
  final t = r == null ? null : _map(r['totals']);
  if (r == null || t == null) return null;
  final income = _int(t['incomeMinor']), gross = _int(t['grossProfitMinor']), profit = _int(t['profitMinor']);
  if (income == null || gross == null || profit == null) return null;
  return BookProfit(from: _text(r['from']) ?? '', to: _text(r['to']) ?? '', income: _bookLines(r['income']), costOfSales: _bookLines(r['costOfSales']), expenses: _bookLines(r['expenses']), incomeMinor: income, grossProfitMinor: gross, profitMinor: profit);
}

BookBalance? parseBalance(int status, Object? body) {
  final r = _bookResult(status, body);
  final t = r == null ? null : _map(r['totals']);
  if (r == null || t == null) return null;
  final assets = _int(t['assetsMinor']), earnings = _int(r['earningsMinor']);
  if (assets == null || earnings == null) return null;
  return BookBalance(asOf: _text(r['asOf']) ?? '', assets: _bookLines(r['assets']), liabilities: _bookLines(r['liabilities']), equity: _bookLines(r['equity']), earningsMinor: earnings, assetsMinor: assets, balanced: r['balanced'] == true);
}

BookReconciliation? parseReconciliation(int status, Object? body) {
  final r = _bookResult(status, body);
  if (r == null || r['lines'] is! List) return null;
  final checks = <BookCheck>[];
  for (final item in _list(r['lines'])) {
    final m = _map(item);
    final d = m == null ? null : _int(m['differenceMinor']);
    if (m == null || d == null) continue;
    checks.add(BookCheck(_text(m['label']) ?? 'Check', d));
  }
  return BookReconciliation(checks, r['agrees'] == true);
}

/// An open item on the bank reconciliation: a date, what it is and the amount in minor units.
class BankItem {
  final String date;
  final String what;
  final int amountMinor;
  const BankItem(this.date, this.what, this.amountMinor);
}

class BankRec {
  final String periodTo;
  final int ledgerMinor;
  final int statementMinor;
  final int unexplainedMinor;
  final bool reconciled;
  final List<BankItem> notOnStatement;
  final List<BankItem> notInBooks;
  const BankRec({required this.periodTo, required this.ledgerMinor, required this.statementMinor, required this.unexplainedMinor, required this.reconciled, required this.notOnStatement, required this.notInBooks});
}

/// True when the engine answered and says there is no bank statement yet (statement: null).
bool bankRecHasNoStatement(int status, Object? body) {
  final r = _bookResult(status, body);
  return r != null && r.containsKey('statement') && r['statement'] == null;
}

BankRec? parseBankRec(int status, Object? body) {
  final r = _bookResult(status, body);
  final st = r == null ? null : _map(r['statement']);
  if (r == null || st == null) return null;
  final ledger = _int(r['ledgerMinor']), statement = _int(r['statementMinor']), unexplained = _int(r['unexplainedMinor']);
  if (ledger == null || statement == null || unexplained == null) return null;
  List<BankItem> items(Object? v, String textKey) {
    final out = <BankItem>[];
    for (final item in _list(v)) {
      final m = _map(item);
      final a = m == null ? null : _int(m['amountMinor']);
      if (m == null || a == null) continue;
      out.add(BankItem(_text(m['date']) ?? '', _text(m[textKey]) ?? _text(m['memo']) ?? 'Entry', a));
    }
    return out;
  }
  return BankRec(periodTo: _text(st['periodTo']) ?? '', ledgerMinor: ledger, statementMinor: statement, unexplainedMinor: unexplained, reconciled: r['reconciled'] == true, notOnStatement: items(r['outstandingEntries'], 'party'), notInBooks: items(r['unmatchedLines'], 'description'));
}

class CashFlow {
  final String from;
  final String to;
  final int openingMinor;
  final List<BookLine> inflows;
  final List<BookLine> outflows;
  final int netMinor;
  final int closingMinor;
  const CashFlow({required this.from, required this.to, required this.openingMinor, required this.inflows, required this.outflows, required this.netMinor, required this.closingMinor});
}

CashFlow? parseCashFlow(int status, Object? body) {
  final r = _bookResult(status, body);
  if (r == null) return null;
  final opening = _int(r['openingMinor']), net = _int(r['netMinor']), closing = _int(r['closingMinor']);
  if (opening == null || net == null || closing == null) return null;
  return CashFlow(from: _text(r['from']) ?? '', to: _text(r['to']) ?? '', openingMinor: opening, inflows: _bookLines(r['inflows']), outflows: _bookLines(r['outflows']), netMinor: net, closingMinor: closing);
}

class ClosedYearEntry {
  final String end;
  final int profitMinor;
  const ClosedYearEntry(this.end, this.profitMinor);
}

class BookYears {
  final String monthName;
  final String currentFrom;
  final String currentTo;
  final List<ClosedYearEntry> closed;
  final String? nextEnd;
  final bool nextEnded;
  const BookYears({required this.monthName, required this.currentFrom, required this.currentTo, required this.closed, required this.nextEnd, required this.nextEnded});
}

BookYears? parseYears(int status, Object? body) {
  final r = _bookResult(status, body);
  final cur = r == null ? null : _map(r['current']);
  if (r == null || cur == null) return null;
  final from = _text(cur['start']), to = _text(cur['end']);
  if (from == null || to == null) return null;
  final closed = <ClosedYearEntry>[];
  for (final item in _list(r['closed'])) {
    final m = _map(item);
    final p = m == null ? null : _int(m['profitMinor']);
    final e = m == null ? null : _text(m['end']);
    if (m == null || p == null || e == null) continue;
    closed.add(ClosedYearEntry(e, p));
  }
  final next = _map(r['nextToClose']);
  return BookYears(monthName: _text(r['yearEndMonthName']) ?? '', currentFrom: from, currentTo: to, closed: closed, nextEnd: next == null ? null : _text(next['end']), nextEnded: next != null && next['ended'] == true);
}

/// A payment received that is not all used up (an overpayment), as GET /engine/credits lists it: how much of it can still be refunded or put against an invoice.
class OverpaymentEntry {
  final int id;
  final String partyName;
  final String currency;
  final String receivedOn;
  final int availableMinor;
  const OverpaymentEntry({required this.id, required this.partyName, required this.currency, required this.receivedOn, required this.availableMinor});
}

/// The overpayments the engine listed, or null when the answer cannot be read. An entry without its figures is left out; nothing is guessed.
List<OverpaymentEntry>? parseOverpayments(int status, Object? body) {
  final r = _bookResult(status, body);
  if (r == null || r['payments'] is! List) return null;
  final out = <OverpaymentEntry>[];
  for (final item in _list(r['payments'])) {
    final m = _map(item);
    final id = m == null ? null : _int(m['id']);
    final available = m == null ? null : _int(m['availableMinor']);
    final on = m == null ? null : _text(m['receivedOn']);
    final currency = m == null ? null : _text(m['currency']);
    if (m == null || id == null || available == null || available < 1 || on == null || currency == null) continue;
    out.add(OverpaymentEntry(id: id, partyName: _text(m['partyName']) ?? 'Customer', currency: currency, receivedOn: on, availableMinor: available));
  }
  return out;
}

class BankAccountEntry {
  final int id;
  final String name;
  final bool isDefault;
  final int balanceMinor;
  const BankAccountEntry({required this.id, required this.name, required this.isDefault, required this.balanceMinor});
}

/// The bank accounts the engine listed (the default first), or null when the answer cannot be read. A row without its figures is left out; the balances are the engine's.
List<BankAccountEntry>? parseBankAccounts(int status, Object? body) {
  final r = _bookResult(status, body);
  if (r == null || r['accounts'] is! List) return null;
  final out = <BankAccountEntry>[];
  for (final item in _list(r['accounts'])) {
    final m = _map(item);
    final id = m == null ? null : _int(m['id']);
    final bal = m == null ? null : _int(m['balanceMinor']);
    final name = m == null ? null : _text(m['name']);
    if (m == null || id == null || bal == null || name == null) continue;
    out.add(BankAccountEntry(id: id, name: name, isDefault: m['isDefault'] == true, balanceMinor: bal));
  }
  return out;
}
