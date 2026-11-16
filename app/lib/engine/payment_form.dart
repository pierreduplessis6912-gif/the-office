// The "record a payment received" form. It fills the payload the assistant would (payment.record) and sends it to be HELD; nothing is recorded until the owner approves it in the Pending room, where the
// invoices it will settle are shown. The engine checks it as it checks a sentence and its own reason is shown when it refuses. The app only turns the typed amount into cents (money_input.dart), reads the
// customers, what each owes and the bank accounts, and refuses what is plainly empty.
import 'package:flutter/material.dart';

import '../slice_model.dart' show parseProposal, parseReceivables, SliceReadKind, randFromMinor;
import 'assistant_model.dart';
import 'engine_api.dart';
import 'money_input.dart';

class PaymentForm extends StatefulWidget {
  final EngineApi api;
  final VoidCallback onClose;
  final DateTime Function()? clock;
  const PaymentForm({super.key, required this.api, required this.onClose, this.clock});

  @override
  State<PaymentForm> createState() => _PaymentFormState();
}

class _PaymentFormState extends State<PaymentForm> {
  static const _methods = <String>['eft', 'cash', 'card', 'cheque', 'other'];
  final _amount = TextEditingController();
  late final TextEditingController _date;
  List<PartyEntry> _customers = <PartyEntry>[];
  List<BankAccountEntry> _accounts = <BankAccountEntry>[];
  bool _loading = true;
  bool _failed = false;
  PartyEntry? _customer;
  String? _currency;
  int? _owedMinor;
  bool _owedUnknown = false;
  String _method = 'eft';
  int? _bankAccountId;
  bool _oldestFirst = true;
  bool _sending = false;
  bool _sent = false;
  String? _problem;

  @override
  void initState() {
    super.initState();
    final d = (widget.clock ?? DateTime.now)();
    String two(int n) => n.toString().padLeft(2, '0');
    _date = TextEditingController(text: '${d.year.toString().padLeft(4, '0')}-${two(d.month)}-${two(d.day)}');
    _load();
  }

  @override
  void dispose() {
    _amount.dispose();
    _date.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    try {
      final p = await widget.api.parties(role: 'customer');
      final a = await widget.api.bankAccounts();
      final list = parsePartyList(p.status, p.body);
      if (!mounted) return;
      setState(() {
        _customers = (list ?? <PartyEntry>[]).where((x) => x.isCustomer).toList();
        _accounts = parseBankAccounts(a.status, a.body) ?? <BankAccountEntry>[];
        _failed = list == null;
        _loading = false;
      });
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _failed = true;
        _loading = false;
      });
    }
  }

  Future<void> _pick(PartyEntry? c) async {
    setState(() {
      _customer = c;
      _currency = null;
      _owedMinor = null;
      _owedUnknown = false;
      _problem = null;
    });
    if (c == null) return;
    try {
      final r = await widget.api.receivables(c.name);
      final read = parseReceivables(r.status, r.body);
      if (!mounted || _customer?.id != c.id) return;
      setState(() {
        if (read.kind == SliceReadKind.answer && read.answer != null) {
          // a customer with no invoices has no currency the engine can name: nothing is guessed
          if (read.answer!.lines.isNotEmpty) {
            _currency = read.answer!.currency;
            _owedMinor = read.answer!.totalMinor;
          }
        } else {
          _owedUnknown = true;
        }
      });
    } catch (_) {
      if (!mounted) return;
      setState(() => _owedUnknown = true);
    }
  }

  Future<void> _send() async {
    final c = _customer;
    if (c == null) return setState(() => _problem = 'Choose the customer first.');
    final minor = randToMinor(_amount.text);
    if (minor == null) return setState(() => _problem = 'Type the amount in rand, for example 450.00.');
    final currency = _currency;
    if (currency == null) return setState(() => _problem = '${c.name} has no invoices yet, so there is nothing to pay.');
    final payload = <String, Object?>{
      'partyId': c.id,
      'amountMinor': minor,
      'currency': currency,
      'occurredOn': _date.text.trim(),
      'method': _method,
      if (_method != 'cash' && _bankAccountId != null) 'bankAccountId': _bankAccountId,
      if (_oldestFirst) 'allocate': 'oldest_first',
    };
    setState(() {
      _sending = true;
      _problem = null;
    });
    String? problem;
    bool held = false;
    try {
      final r = await widget.api.propose('payment.record', payload, 'Added from the Record a payment form');
      final p = parseProposal(r.status, r.body);
      held = p.held;
      if (!held) problem = p.message ?? 'That could not be sent. Try again.';
    } catch (_) {
      problem = 'That could not be sent. Try again.';
    }
    if (!mounted) return;
    setState(() {
      _sending = false;
      _sent = held;
      _problem = problem;
    });
  }

  @override
  Widget build(BuildContext context) {
    if (_sent) {
      return SafeArea(
        child: ListView(padding: const EdgeInsets.all(12), children: [
          const Text('Sent for approval', key: Key('payment-form-sent'), style: TextStyle(fontSize: 18, fontWeight: FontWeight.w600)),
          const Padding(padding: EdgeInsets.symmetric(vertical: 8), child: Text('It is waiting in Pending, where you will see which invoices it settles. Nothing is recorded until you approve it.')),
          FilledButton(key: const Key('payment-form-done'), onPressed: widget.onClose, child: const Text('Done')),
        ]),
      );
    }
    if (_loading) return const SafeArea(child: Padding(padding: EdgeInsets.all(12), child: Text('Reading…', style: TextStyle(color: Color(0xFF8A8A90)))));
    if (_failed) {
      return SafeArea(
        child: ListView(padding: const EdgeInsets.all(12), children: [
          const Text('The customers could not be read. Try again.', key: Key('payment-form-error')),
          TextButton(key: const Key('payment-form-cancel'), onPressed: widget.onClose, child: const Text('Close')),
        ]),
      );
    }
    final showAccounts = _accounts.length > 1 && _method != 'cash';
    return SafeArea(
      child: ListView(padding: const EdgeInsets.all(12), children: [
        const Text('Record a payment received', style: TextStyle(fontSize: 18, fontWeight: FontWeight.w600)),
        const SizedBox(height: 8),
        DropdownButtonFormField<int>(
          key: const Key('payment-form-customer'),
          decoration: const InputDecoration(labelText: 'Customer'),
          initialValue: _customer?.id,
          items: [for (final c in _customers) DropdownMenuItem<int>(value: c.id, child: Text(c.name))],
          onChanged: (id) => _pick(id == null ? null : _customers.firstWhere((c) => c.id == id)),
        ),
        if (_owedMinor != null) Padding(padding: const EdgeInsets.only(top: 4), child: Text('Owes ${randFromMinor(_owedMinor!, currency: _currency ?? 'ZAR')}', key: const Key('payment-form-owes'))),
        if (_owedUnknown) const Padding(padding: EdgeInsets.only(top: 4), child: Text('What they owe could not be read.', key: Key('payment-form-owes-unknown'))),
        TextField(key: const Key('payment-form-amount'), controller: _amount, keyboardType: const TextInputType.numberWithOptions(decimal: true), decoration: const InputDecoration(labelText: 'Amount (rand)')),
        TextField(key: const Key('payment-form-date'), controller: _date, decoration: const InputDecoration(labelText: 'Date received (YYYY-MM-DD)')),
        DropdownButtonFormField<String>(
          key: const Key('payment-form-method'),
          decoration: const InputDecoration(labelText: 'How it was paid'),
          initialValue: _method,
          items: [for (final m in _methods) DropdownMenuItem<String>(value: m, child: Text(m))],
          onChanged: (m) => setState(() => _method = m ?? 'eft'),
        ),
        if (showAccounts)
          DropdownButtonFormField<int>(
            key: const Key('payment-form-account'),
            decoration: const InputDecoration(labelText: 'Into which bank account'),
            initialValue: _bankAccountId ?? _accounts.firstWhere((a) => a.isDefault, orElse: () => _accounts.first).id,
            items: [for (final a in _accounts) DropdownMenuItem<int>(value: a.id, child: Text(a.name))],
            onChanged: (id) => setState(() => _bankAccountId = id),
          ),
        SwitchListTile(key: const Key('payment-form-oldest'), contentPadding: EdgeInsets.zero, title: const Text('Settle the oldest invoices first'), value: _oldestFirst, onChanged: (v) => setState(() => _oldestFirst = v)),
        if (_problem != null) Padding(padding: const EdgeInsets.only(top: 8), child: Text(_problem!, key: const Key('payment-form-problem'), style: const TextStyle(color: Color(0xFFB3261E)))),
        const SizedBox(height: 12),
        Row(children: [
          FilledButton(key: const Key('payment-form-send'), onPressed: _sending ? null : _send, child: Text(_sending ? 'Sending…' : 'Send for approval')),
          const SizedBox(width: 8),
          TextButton(key: const Key('payment-form-cancel'), onPressed: _sending ? null : widget.onClose, child: const Text('Cancel')),
        ]),
      ]),
    );
  }
}
