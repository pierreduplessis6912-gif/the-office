// The "pay a supplier" form. It fills the payload the assistant would (supplier_payment.record) and sends it to be HELD; nothing is paid until the owner approves it. Bills are settled oldest first when asked;
// otherwise the assistant names them. Currency is rand; the engine refuses a bill in another currency and says why. The app only turns the typed amount into cents and refuses what is plainly empty.
import 'package:flutter/material.dart';

import 'assistant_model.dart';
import 'engine_api.dart';
import 'money_input.dart';
import '../slice_model.dart' show parseProposal;

class SupplierPaymentForm extends StatefulWidget {
  final EngineApi api;
  final VoidCallback onClose;
  final DateTime Function()? clock;
  const SupplierPaymentForm({super.key, required this.api, required this.onClose, this.clock});

  @override
  State<SupplierPaymentForm> createState() => _SupplierPaymentFormState();
}

class _SupplierPaymentFormState extends State<SupplierPaymentForm> {
  static const _methods = <String>['eft', 'cash', 'card', 'cheque', 'other'];
  final _amount = TextEditingController();
  late final TextEditingController _date;
  List<PartyEntry> _suppliers = <PartyEntry>[];
  List<BankAccountEntry> _accounts = <BankAccountEntry>[];
  bool _loading = true;
  bool _failed = false;
  PartyEntry? _supplier;
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
    final payload = <String, Object?>{
      'supplierId': s.id,
      'amountMinor': minor,
      'currency': 'ZAR',
      'paidOn': _date.text.trim(),
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
      final r = await widget.api.propose('supplier_payment.record', payload, 'Added from the Pay a supplier form');
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
          const Text('Sent for approval', key: Key('supplier-payment-form-sent'), style: TextStyle(fontSize: 18, fontWeight: FontWeight.w600)),
          const Padding(padding: EdgeInsets.symmetric(vertical: 8), child: Text('It is waiting in Pending, where you will see which bills it settles. Nothing is paid until you approve it.')),
          FilledButton(key: const Key('supplier-payment-form-done'), onPressed: widget.onClose, child: const Text('Done')),
        ]),
      );
    }
    if (_loading) return const SafeArea(child: Padding(padding: EdgeInsets.all(12), child: Text('Reading…', style: TextStyle(color: Color(0xFF8A8A90)))));
    if (_failed) {
      return SafeArea(
        child: ListView(padding: const EdgeInsets.all(12), children: [
          const Text('The suppliers could not be read. Try again.', key: Key('supplier-payment-form-error')),
          TextButton(key: const Key('supplier-payment-form-cancel'), onPressed: widget.onClose, child: const Text('Close')),
        ]),
      );
    }
    final showAccounts = _accounts.length > 1 && _method != 'cash';
    return SafeArea(
      child: ListView(padding: const EdgeInsets.all(12), children: [
        const Text('Pay a supplier', style: TextStyle(fontSize: 18, fontWeight: FontWeight.w600)),
        const SizedBox(height: 8),
        DropdownButtonFormField<int>(
          key: const Key('supplier-payment-form-supplier'),
          decoration: const InputDecoration(labelText: 'Supplier'),
          initialValue: _supplier?.id,
          items: [for (final x in _suppliers) DropdownMenuItem<int>(value: x.id, child: Text(x.name))],
          onChanged: (id) => setState(() => _supplier = id == null ? null : _suppliers.firstWhere((x) => x.id == id)),
        ),
        TextField(key: const Key('supplier-payment-form-amount'), controller: _amount, keyboardType: const TextInputType.numberWithOptions(decimal: true), decoration: const InputDecoration(labelText: 'Amount paid (rand)')),
        TextField(key: const Key('supplier-payment-form-date'), controller: _date, decoration: const InputDecoration(labelText: 'Date paid (YYYY-MM-DD)')),
        DropdownButtonFormField<String>(
          key: const Key('supplier-payment-form-method'),
          decoration: const InputDecoration(labelText: 'How it was paid'),
          initialValue: _method,
          items: [for (final m in _methods) DropdownMenuItem<String>(value: m, child: Text(m))],
          onChanged: (m) => setState(() => _method = m ?? 'eft'),
        ),
        if (showAccounts)
          DropdownButtonFormField<int>(
            key: const Key('supplier-payment-form-account'),
            decoration: const InputDecoration(labelText: 'Paid from which bank account'),
            initialValue: _bankAccountId ?? _accounts.firstWhere((a) => a.isDefault, orElse: () => _accounts.first).id,
            items: [for (final a in _accounts) DropdownMenuItem<int>(value: a.id, child: Text(a.name))],
            onChanged: (id) => setState(() => _bankAccountId = id),
          ),
        SwitchListTile(key: const Key('supplier-payment-form-oldest'), contentPadding: EdgeInsets.zero, title: const Text('Pay the oldest bills first'), value: _oldestFirst, onChanged: (v) => setState(() => _oldestFirst = v)),
        if (_problem != null) Padding(padding: const EdgeInsets.only(top: 8), child: Text(_problem!, key: const Key('supplier-payment-form-problem'), style: const TextStyle(color: Color(0xFFB3261E)))),
        const SizedBox(height: 12),
        Row(children: [
          FilledButton(key: const Key('supplier-payment-form-send'), onPressed: _sending ? null : _send, child: Text(_sending ? 'Sending…' : 'Send for approval')),
          const SizedBox(width: 8),
          TextButton(key: const Key('supplier-payment-form-cancel'), onPressed: widget.onClose, child: const Text('Cancel')),
        ]),
      ]),
    );
  }
}
