// The "make a quotation" form. It fills the payload the assistant would (quotation.create) and sends it to be HELD; nothing is made until the owner approves it. Lines come from the line editor; the engine
// works out the totals and refuses a customer that is not one, and its own reason is shown. Currency is rand. The app only turns what was typed into the engine's shapes and refuses what is plainly empty.
import 'package:flutter/material.dart';

import '../slice_model.dart' show parseProposal;
import 'assistant_model.dart';
import 'engine_api.dart';
import 'line_editor.dart';

class QuotationForm extends StatefulWidget {
  final EngineApi api;
  final VoidCallback onClose;
  final DateTime Function()? clock;
  const QuotationForm({super.key, required this.api, required this.onClose, this.clock});

  @override
  State<QuotationForm> createState() => _QuotationFormState();
}

class _QuotationFormState extends State<QuotationForm> {
  final _lines = LineEditorController();
  final _reference = TextEditingController();
  final _validUntil = TextEditingController();
  late final TextEditingController _date;
  List<PartyEntry> _customers = <PartyEntry>[];
  bool _loading = true;
  bool _failed = false;
  PartyEntry? _customer;
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
    _lines.dispose();
    _reference.dispose();
    _validUntil.dispose();
    _date.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    try {
      final p = await widget.api.parties(role: 'customer');
      final list = parsePartyList(p.status, p.body);
      if (!mounted) return;
      setState(() {
        _customers = (list ?? <PartyEntry>[]).where((x) => x.isCustomer).toList();
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
    final c = _customer;
    if (c == null) return setState(() => _problem = 'Choose the customer first.');
    String? bad;
    final lines = _lines.read((p) => bad = p);
    if (lines == null) return setState(() => _problem = bad);
    final ref = _reference.text.trim();
    final until = _validUntil.text.trim();
    final payload = <String, Object?>{
      'partyId': c.id,
      'issuedOn': _date.text.trim(),
      'currency': 'ZAR',
      if (until.isNotEmpty) 'validUntil': until,
      if (ref.isNotEmpty) 'reference': ref,
      'lines': lines,
    };
    setState(() {
      _sending = true;
      _problem = null;
    });
    String? problem;
    bool held = false;
    try {
      final r = await widget.api.propose('quotation.create', payload, 'Added from the Make a quotation form');
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
          const Text('Sent for approval', key: Key('quotation-form-sent'), style: TextStyle(fontSize: 18, fontWeight: FontWeight.w600)),
          const Padding(padding: EdgeInsets.symmetric(vertical: 8), child: Text('It is waiting in Pending, where you will see the totals the engine worked out. Nothing is made until you approve it.')),
          FilledButton(key: const Key('quotation-form-done'), onPressed: widget.onClose, child: const Text('Done')),
        ]),
      );
    }
    if (_loading) return const SafeArea(child: Padding(padding: EdgeInsets.all(12), child: Text('Reading…', style: TextStyle(color: Color(0xFF8A8A90)))));
    if (_failed) {
      return SafeArea(
        child: ListView(padding: const EdgeInsets.all(12), children: [
          const Text('The customers could not be read. Try again.', key: Key('quotation-form-error')),
          TextButton(key: const Key('quotation-form-cancel'), onPressed: widget.onClose, child: const Text('Close')),
        ]),
      );
    }
    return SafeArea(
      child: ListView(padding: const EdgeInsets.all(12), children: [
        const Text('Make a quotation', style: TextStyle(fontSize: 18, fontWeight: FontWeight.w600)),
        const SizedBox(height: 8),
        DropdownButtonFormField<int>(
          key: const Key('quotation-form-customer'),
          decoration: const InputDecoration(labelText: 'Customer'),
          initialValue: _customer?.id,
          items: [for (final c in _customers) DropdownMenuItem<int>(value: c.id, child: Text(c.name))],
          onChanged: (id) => setState(() => _customer = id == null ? null : _customers.firstWhere((c) => c.id == id)),
        ),
        TextField(key: const Key('quotation-form-date'), controller: _date, decoration: const InputDecoration(labelText: 'Date (YYYY-MM-DD)')),
        TextField(key: const Key('quotation-form-valid'), controller: _validUntil, decoration: const InputDecoration(labelText: 'Valid until (YYYY-MM-DD, optional)')),
        TextField(key: const Key('quotation-form-reference'), controller: _reference, decoration: const InputDecoration(labelText: 'Reference (optional)')),
        const SizedBox(height: 8),
        LineEditor(controller: _lines, keyPrefix: 'quotation-form'),
        if (_problem != null) Padding(padding: const EdgeInsets.only(top: 8), child: Text(_problem!, key: const Key('quotation-form-problem'), style: const TextStyle(color: Color(0xFFB3261E)))),
        const SizedBox(height: 12),
        Row(children: [
          FilledButton(key: const Key('quotation-form-send'), onPressed: _sending ? null : _send, child: Text(_sending ? 'Sending…' : 'Send for approval')),
          const SizedBox(width: 8),
          TextButton(key: const Key('quotation-form-cancel'), onPressed: widget.onClose, child: const Text('Cancel')),
        ]),
      ]),
    );
  }
}
