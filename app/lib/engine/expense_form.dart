// The "record an expense" form. It fills the payload the assistant would (expense.record) and sends it to be HELD; nothing is recorded until the owner approves it. The engine works out the VAT it may claim
// and refuses what it cannot accept, and its own reason is shown. The app only turns the typed amount into cents, names the VAT choice as a rate, and refuses what is plainly empty. One line per expense here;
// an expense with several lines is still said to the assistant.
import 'package:flutter/material.dart';

import 'assistant_model.dart';
import 'engine_api.dart';
import 'money_input.dart';
import '../slice_model.dart' show parseProposal;

class ExpenseForm extends StatefulWidget {
  final EngineApi api;
  final VoidCallback onClose;
  final DateTime Function()? clock;
  const ExpenseForm({super.key, required this.api, required this.onClose, this.clock});

  @override
  State<ExpenseForm> createState() => _ExpenseFormState();
}

class _ExpenseFormState extends State<ExpenseForm> {
  // the engine's own list (worker/src/engine/expenses.ts); it refuses anything else and says why
  static const categories = <String>[
    'advertising', 'bank_charges', 'cleaning', 'consumables', 'entertainment', 'fuel', 'insurance', 'materials', 'motor_car', 'office_supplies', 'professional_fees', 'rent', 'repairs', 'stationery',
    'subscriptions', 'club_subscription', 'telephone', 'tools', 'travel', 'utilities', 'other',
  ];
  static const _methods = <String>['eft', 'cash', 'card', 'cheque', 'other'];
  final _amount = TextEditingController();
  final _what = TextEditingController();
  late final TextEditingController _date;
  List<PartyEntry> _suppliers = <PartyEntry>[];
  List<BankAccountEntry> _accounts = <BankAccountEntry>[];
  bool _loading = true;
  bool _failed = false;
  PartyEntry? _supplier;
  String _category = 'other';
  String _method = 'eft';
  int? _bankAccountId;
  bool _vat = true;
  bool _includesVat = true;
  bool _taxInvoice = true;
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
    _what.dispose();
    _date.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    try {
      final p = await widget.api.parties(role: 'supplier');
      final a = await widget.api.bankAccounts();
      final list = parsePartyList(p.status, p.body);
      if (!mounted) return;
      setState(() {
        _suppliers = (list ?? <PartyEntry>[]).where((x) => x.roles.contains('supplier')).toList();
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

  Future<void> _send() async {
    final s = _supplier;
    if (s == null) return setState(() => _problem = 'Choose the supplier first.');
    final minor = randToMinor(_amount.text);
    if (minor == null) return setState(() => _problem = 'Type the amount in rand, for example 450.00.');
    final what = _what.text.trim().isEmpty ? _category.replaceAll('_', ' ') : _what.text.trim();
    final payload = <String, Object?>{
      'supplierId': s.id,
      'incurredOn': _date.text.trim(),
      'paidOn': _date.text.trim(),
      'method': _method,
      if (_method != 'cash' && _bankAccountId != null) 'bankAccountId': _bankAccountId,
      'category': _category,
      'currency': 'ZAR',
      'amountsIncludeTax': _vat && _includesVat,
      'taxInvoiceHeld': _taxInvoice,
      'amountPaidMinor': minor,
      'lines': [
        <String, Object?>{'description': what, 'amountMinor': minor, 'taxBp': _vat ? 1500 : 0},
      ],
    };
    setState(() {
      _sending = true;
      _problem = null;
    });
    String? problem;
    bool held = false;
    try {
      final r = await widget.api.propose('expense.record', payload, 'Added from the Record an expense form');
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
          const Text('Sent for approval', key: Key('expense-form-sent'), style: TextStyle(fontSize: 18, fontWeight: FontWeight.w600)),
          const Padding(padding: EdgeInsets.symmetric(vertical: 8), child: Text('It is waiting in Pending, where you will see the VAT it may claim. Nothing is recorded until you approve it.')),
          FilledButton(key: const Key('expense-form-done'), onPressed: widget.onClose, child: const Text('Done')),
        ]),
      );
    }
    if (_loading) return const SafeArea(child: Padding(padding: EdgeInsets.all(12), child: Text('Reading…', style: TextStyle(color: Color(0xFF8A8A90)))));
    if (_failed) {
      return SafeArea(
        child: ListView(padding: const EdgeInsets.all(12), children: [
          const Text('The suppliers could not be read. Try again.', key: Key('expense-form-error')),
          TextButton(key: const Key('expense-form-cancel'), onPressed: widget.onClose, child: const Text('Close')),
        ]),
      );
    }
    final showAccounts = _accounts.length > 1 && _method != 'cash';
    return SafeArea(
      child: ListView(padding: const EdgeInsets.all(12), children: [
        const Text('Record an expense', style: TextStyle(fontSize: 18, fontWeight: FontWeight.w600)),
        const SizedBox(height: 8),
        DropdownButtonFormField<int>(
          key: const Key('expense-form-supplier'),
          decoration: const InputDecoration(labelText: 'Supplier'),
          initialValue: _supplier?.id,
          items: [for (final x in _suppliers) DropdownMenuItem<int>(value: x.id, child: Text(x.name))],
          onChanged: (id) => setState(() => _supplier = id == null ? null : _suppliers.firstWhere((x) => x.id == id)),
        ),
        TextField(key: const Key('expense-form-amount'), controller: _amount, keyboardType: const TextInputType.numberWithOptions(decimal: true), decoration: const InputDecoration(labelText: 'Amount paid (rand)')),
        TextField(key: const Key('expense-form-what'), controller: _what, decoration: const InputDecoration(labelText: 'What it was for (optional)')),
        TextField(key: const Key('expense-form-date'), controller: _date, decoration: const InputDecoration(labelText: 'Date paid (YYYY-MM-DD)')),
        DropdownButtonFormField<String>(
          key: const Key('expense-form-category'),
          decoration: const InputDecoration(labelText: 'Category'),
          initialValue: _category,
          items: [for (final c in categories) DropdownMenuItem<String>(value: c, child: Text(c.replaceAll('_', ' ')))],
          onChanged: (c) => setState(() => _category = c ?? 'other'),
        ),
        DropdownButtonFormField<String>(
          key: const Key('expense-form-method'),
          decoration: const InputDecoration(labelText: 'How it was paid'),
          initialValue: _method,
          items: [for (final m in _methods) DropdownMenuItem<String>(value: m, child: Text(m))],
          onChanged: (m) => setState(() => _method = m ?? 'eft'),
        ),
        if (showAccounts)
          DropdownButtonFormField<int>(
            key: const Key('expense-form-account'),
            decoration: const InputDecoration(labelText: 'Paid from which bank account'),
            initialValue: _bankAccountId ?? _accounts.firstWhere((a) => a.isDefault, orElse: () => _accounts.first).id,
            items: [for (final a in _accounts) DropdownMenuItem<int>(value: a.id, child: Text(a.name))],
            onChanged: (id) => setState(() => _bankAccountId = id),
          ),
        SwitchListTile(key: const Key('expense-form-vat'), contentPadding: EdgeInsets.zero, title: const Text('This purchase has VAT (15%)'), value: _vat, onChanged: (v) => setState(() => _vat = v)),
        if (_vat) SwitchListTile(key: const Key('expense-form-includes'), contentPadding: EdgeInsets.zero, title: const Text('The amount already includes VAT'), value: _includesVat, onChanged: (v) => setState(() => _includesVat = v)),
        SwitchListTile(key: const Key('expense-form-invoice'), contentPadding: EdgeInsets.zero, title: const Text('I have the tax invoice'), value: _taxInvoice, onChanged: (v) => setState(() => _taxInvoice = v)),
        if (_problem != null) Padding(padding: const EdgeInsets.only(top: 8), child: Text(_problem!, key: const Key('expense-form-problem'), style: const TextStyle(color: Color(0xFFB3261E)))),
        const SizedBox(height: 12),
        Row(children: [
          FilledButton(key: const Key('expense-form-send'), onPressed: _sending ? null : _send, child: Text(_sending ? 'Sending…' : 'Send for approval')),
          const SizedBox(width: 8),
          TextButton(key: const Key('expense-form-cancel'), onPressed: widget.onClose, child: const Text('Cancel')),
        ]),
      ]),
    );
  }
}
