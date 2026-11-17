// The "refund an overpayment" form. The engine lists the payments received that are not all used up (GET /engine/credits) and how much of each can still be refunded; the person picks one, the amount (the whole
// of it to start) and the date, and the form proposes payment.refund, which is HELD: nothing is paid out until the owner approves it. The engine checks the amount against what is left and its reason is shown.
// With more than one bank account it also asks which one the money is paid back from (never for cash). The app only turns the typed amount into cents. A credit note's refund is still said to the assistant.
import 'package:flutter/material.dart';

import '../slice_model.dart' show parseProposal, randFromMinor;
import 'assistant_model.dart';
import 'engine_api.dart';
import 'money_input.dart';

class RefundForm extends StatefulWidget {
  final EngineApi api;
  final VoidCallback onClose;
  final DateTime Function()? clock;
  const RefundForm({super.key, required this.api, required this.onClose, this.clock});

  @override
  State<RefundForm> createState() => _RefundFormState();
}

class _RefundFormState extends State<RefundForm> {
  static const _methods = <String>['eft', 'cash', 'card', 'cheque', 'other'];
  final _amount = TextEditingController();
  late final TextEditingController _date;
  List<OverpaymentEntry> _payments = <OverpaymentEntry>[];
  List<BankAccountEntry> _accounts = <BankAccountEntry>[];
  int? _bankAccountId;
  bool _loading = true;
  bool _failed = false;
  OverpaymentEntry? _payment;
  String _method = 'eft';
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
      final r = await widget.api.credits();
      final a = await widget.api.bankAccounts();
      final list = parseOverpayments(r.status, r.body);
      if (!mounted) return;
      setState(() {
        _accounts = parseBankAccounts(a.status, a.body) ?? <BankAccountEntry>[];
        _payments = list ?? <OverpaymentEntry>[];
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

  String _plain(int minor) {
    final whole = minor ~/ 100;
    final cents = (minor % 100).toString().padLeft(2, '0');
    return '$whole.$cents';
  }

  void _pick(OverpaymentEntry? p) {
    setState(() {
      _payment = p;
      _problem = null;
      if (p != null) _amount.text = _plain(p.availableMinor);
    });
  }

  Future<void> _send() async {
    final p = _payment;
    if (p == null) return setState(() => _problem = 'Choose the payment to refund first.');
    final minor = randToMinor(_amount.text);
    if (minor == null) return setState(() => _problem = 'Type the amount in rand, for example 450.00.');
    if (minor > p.availableMinor) return setState(() => _problem = 'Only ${randFromMinor(p.availableMinor, currency: p.currency)} of that payment is left to refund.');
    final payload = <String, Object?>{'paymentId': p.id, 'amountMinor': minor, 'refundedOn': _date.text.trim(), 'method': _method, if (_method != 'cash' && _bankAccountId != null) 'bankAccountId': _bankAccountId};
    setState(() {
      _sending = true;
      _problem = null;
    });
    String? problem;
    bool held = false;
    try {
      final r = await widget.api.propose('payment.refund', payload, 'Added from the Refund an overpayment form');
      final pr = parseProposal(r.status, r.body);
      held = pr.held;
      if (!held) problem = pr.message ?? 'That could not be sent. Try again.';
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
          const Text('Sent for approval', key: Key('refund-form-sent'), style: TextStyle(fontSize: 18, fontWeight: FontWeight.w600)),
          const Padding(padding: EdgeInsets.symmetric(vertical: 8), child: Text('It is waiting in Pending. Nothing is paid out until you approve it.')),
          FilledButton(key: const Key('refund-form-done'), onPressed: widget.onClose, child: const Text('Done')),
        ]),
      );
    }
    if (_loading) return const SafeArea(child: Padding(padding: EdgeInsets.all(12), child: Text('Reading…', style: TextStyle(color: Color(0xFF8A8A90)))));
    if (_failed) {
      return SafeArea(
        child: ListView(padding: const EdgeInsets.all(12), children: [
          const Text('The payments could not be read. Try again.', key: Key('refund-form-error')),
          TextButton(key: const Key('refund-form-cancel'), onPressed: widget.onClose, child: const Text('Close')),
        ]),
      );
    }
    if (_payments.isEmpty) {
      return SafeArea(
        child: ListView(padding: const EdgeInsets.all(12), children: [
          const Text('No payment has money left to refund.', key: Key('refund-form-none')),
          TextButton(key: const Key('refund-form-cancel'), onPressed: widget.onClose, child: const Text('Close')),
        ]),
      );
    }
    return SafeArea(
      child: ListView(padding: const EdgeInsets.all(12), children: [
        const Text('Refund an overpayment', style: TextStyle(fontSize: 18, fontWeight: FontWeight.w600)),
        const SizedBox(height: 8),
        DropdownButtonFormField<int>(
          key: const Key('refund-form-payment'),
          isExpanded: true,
          decoration: const InputDecoration(labelText: 'Which payment'),
          initialValue: _payment?.id,
          items: [for (final p in _payments) DropdownMenuItem<int>(value: p.id, child: Text('${p.partyName}, ${p.receivedOn}, ${randFromMinor(p.availableMinor, currency: p.currency)} left', overflow: TextOverflow.ellipsis))],
          onChanged: (id) => _pick(id == null ? null : _payments.firstWhere((p) => p.id == id)),
        ),
        TextField(key: const Key('refund-form-amount'), controller: _amount, keyboardType: const TextInputType.numberWithOptions(decimal: true), decoration: const InputDecoration(labelText: 'Amount to refund (rand)')),
        TextField(key: const Key('refund-form-date'), controller: _date, decoration: const InputDecoration(labelText: 'Date refunded (YYYY-MM-DD)')),
        DropdownButtonFormField<String>(
          key: const Key('refund-form-method'),
          decoration: const InputDecoration(labelText: 'How it is paid back'),
          initialValue: _method,
          items: [for (final m in _methods) DropdownMenuItem<String>(value: m, child: Text(m))],
          onChanged: (m) => setState(() => _method = m ?? 'eft'),
        ),
        if (_accounts.length > 1 && _method != 'cash')
          DropdownButtonFormField<int>(
            key: const Key('refund-form-account'),
            decoration: const InputDecoration(labelText: 'Paid back from which bank account'),
            initialValue: _bankAccountId ?? _accounts.firstWhere((a) => a.isDefault, orElse: () => _accounts.first).id,
            items: [for (final a in _accounts) DropdownMenuItem<int>(value: a.id, child: Text(a.name))],
            onChanged: (id) => setState(() => _bankAccountId = id),
          ),
        if (_problem != null) Padding(padding: const EdgeInsets.only(top: 8), child: Text(_problem!, key: const Key('refund-form-problem'), style: const TextStyle(color: Color(0xFFB3261E)))),
        const SizedBox(height: 12),
        Row(children: [
          FilledButton(key: const Key('refund-form-send'), onPressed: _sending ? null : _send, child: Text(_sending ? 'Sending…' : 'Send for approval')),
          const SizedBox(width: 8),
          TextButton(key: const Key('refund-form-cancel'), onPressed: widget.onClose, child: const Text('Cancel')),
        ]),
      ]),
    );
  }
}
