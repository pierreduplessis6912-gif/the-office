// The new customer or supplier form. It is another way to say a sentence: it fills the payload the assistant would (party.create) and sends it to be HELD; nothing is recorded until the owner
// approves it in the Pending room. The engine checks it exactly as it checks a sentence and its own reason is shown when it refuses; the app decides no business rule (it only refuses an empty name
// or no role, so nothing useless is sent).
import 'package:flutter/material.dart';

import '../slice_model.dart' show parseProposal;
import 'engine_api.dart';

class PartyForm extends StatefulWidget {
  final EngineApi api;
  final VoidCallback onClose;
  const PartyForm({super.key, required this.api, required this.onClose});

  @override
  State<PartyForm> createState() => _PartyFormState();
}

class _PartyFormState extends State<PartyForm> {
  final _name = TextEditingController();
  final _phone = TextEditingController();
  final _email = TextEditingController();
  bool _organisation = false;
  bool _customer = true;
  bool _supplier = false;
  bool _sending = false;
  bool _sent = false;
  String? _problem;

  @override
  void dispose() {
    _name.dispose();
    _phone.dispose();
    _email.dispose();
    super.dispose();
  }

  Future<void> _send() async {
    final name = _name.text.trim();
    if (name.isEmpty) return setState(() => _problem = 'Type the name first.');
    if (!_customer && !_supplier) return setState(() => _problem = 'Choose customer, supplier or both.');
    final contact = <String, Object?>{
      if (_phone.text.trim().isNotEmpty) 'phone': _phone.text.trim(),
      if (_email.text.trim().isNotEmpty) 'email': _email.text.trim(),
    };
    final payload = <String, Object?>{
      'kind': _organisation ? 'organisation' : 'person',
      'name': name,
      'roles': <String>[if (_customer) 'customer', if (_supplier) 'supplier'],
      if (contact.isNotEmpty) 'contact': contact,
    };
    setState(() {
      _sending = true;
      _problem = null;
    });
    String? problem;
    bool held = false;
    try {
      final r = await widget.api.propose('party.create', payload, 'Added from the New customer or supplier form');
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
          const Text('Sent for approval', key: Key('party-form-sent'), style: TextStyle(fontSize: 18, fontWeight: FontWeight.w600)),
          const Padding(padding: EdgeInsets.symmetric(vertical: 8), child: Text('It is waiting in Pending. Nothing is added until you approve it.')),
          FilledButton(key: const Key('party-form-done'), onPressed: widget.onClose, child: const Text('Done')),
        ]),
      );
    }
    return SafeArea(
      child: ListView(padding: const EdgeInsets.all(12), children: [
        const Text('New customer or supplier', style: TextStyle(fontSize: 18, fontWeight: FontWeight.w600)),
        const SizedBox(height: 8),
        TextField(key: const Key('party-form-name'), controller: _name, decoration: const InputDecoration(labelText: 'Name')),
        const SizedBox(height: 8),
        SegmentedButton<bool>(
          key: const Key('party-form-kind'),
          segments: const [ButtonSegment(value: false, label: Text('Person')), ButtonSegment(value: true, label: Text('Business'))],
          selected: <bool>{_organisation},
          onSelectionChanged: (s) => setState(() => _organisation = s.first),
        ),
        Row(children: [
          FilterChip(key: const Key('party-form-customer'), label: const Text('Customer'), selected: _customer, onSelected: (v) => setState(() => _customer = v)),
          const SizedBox(width: 8),
          FilterChip(key: const Key('party-form-supplier'), label: const Text('Supplier'), selected: _supplier, onSelected: (v) => setState(() => _supplier = v)),
        ]),
        TextField(key: const Key('party-form-phone'), controller: _phone, keyboardType: TextInputType.phone, decoration: const InputDecoration(labelText: 'Phone (optional)')),
        TextField(key: const Key('party-form-email'), controller: _email, keyboardType: TextInputType.emailAddress, decoration: const InputDecoration(labelText: 'Email (optional)')),
        if (_problem != null) Padding(padding: const EdgeInsets.only(top: 8), child: Text(_problem!, key: const Key('party-form-problem'), style: const TextStyle(color: Color(0xFFB3261E)))),
        const SizedBox(height: 12),
        Row(children: [
          FilledButton(key: const Key('party-form-send'), onPressed: _sending ? null : _send, child: Text(_sending ? 'Sending…' : 'Send for approval')),
          const SizedBox(width: 8),
          TextButton(key: const Key('party-form-cancel'), onPressed: _sending ? null : widget.onClose, child: const Text('Cancel')),
        ]),
      ]),
    );
  }
}
