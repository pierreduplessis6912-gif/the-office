// The change a customer or supplier form. It is another way to say a sentence: it fills the payload the assistant would (party.edit: the name and contact details that CHANGED, a detail left empty is
// cleared) and sends it to be HELD; nothing changes until the owner approves it in the Pending room. The engine checks it exactly as it checks a sentence and its own reason is shown when it refuses; the app
// decides no business rule (it only refuses an empty name, a change of nothing, and a payment term that is not whole days, so nothing useless is sent).
import 'package:flutter/material.dart';

import '../slice_model.dart' show parseProposal;
import 'assistant_model.dart';
import 'engine_api.dart';

class PartyEditForm extends StatefulWidget {
  final EngineApi api;
  final PartyEntry party;
  final VoidCallback onClose;
  const PartyEditForm({super.key, required this.api, required this.party, required this.onClose});

  @override
  State<PartyEditForm> createState() => _PartyEditFormState();
}

class _PartyEditFormState extends State<PartyEditForm> {
  late final _name = TextEditingController(text: widget.party.name);
  late final _phone = TextEditingController(text: widget.party.phone);
  late final _email = TextEditingController(text: widget.party.email);
  late final _address = TextEditingController(text: widget.party.address);
  late final _terms = TextEditingController(text: widget.party.paymentTermsDays);
  bool _sending = false;
  bool _sent = false;
  String? _problem;

  @override
  void dispose() {
    _name.dispose();
    _phone.dispose();
    _email.dispose();
    _address.dispose();
    _terms.dispose();
    super.dispose();
  }

  Future<void> _send() async {
    final p = widget.party;
    final name = _name.text.trim();
    if (name.isEmpty) return setState(() => _problem = 'The name cannot be empty.');
    final terms = _terms.text.trim();
    if (p.isCustomer && terms.isNotEmpty) {
      if (!RegExp(r'^(0|[1-9][0-9]{0,2})$').hasMatch(terms)) return setState(() => _problem = 'The payment term is a whole number of days, like 30.');
      if (int.parse(terms) > 365) return setState(() => _problem = 'The payment term can be at most 365 days.');
    }
    // only what changed is sent; a detail that had a value and is now empty is cleared (null)
    final contact = <String, Object?>{};
    void detail(String key, String now, String before) {
      if (now == before) return;
      if (now.isEmpty) {
        contact[key] = null;
      } else {
        contact[key] = now;
      }
    }

    detail('phone', _phone.text.trim(), p.phone);
    detail('email', _email.text.trim(), p.email);
    detail('address', _address.text.trim(), p.address);
    if (p.isCustomer) detail('paymentTermsDays', terms, p.paymentTermsDays);
    final payload = <String, Object?>{
      'partyId': p.id,
      if (name != p.name) 'name': name,
      if (contact.isNotEmpty) 'contact': contact,
    };
    if (payload.length == 1) return setState(() => _problem = 'Nothing is changed.');
    setState(() {
      _sending = true;
      _problem = null;
    });
    String? problem;
    bool held = false;
    try {
      final r = await widget.api.propose('party.edit', payload, 'Changed from the Change customer or supplier form');
      final parsed = parseProposal(r.status, r.body);
      held = parsed.held;
      if (!held) problem = parsed.message ?? 'That could not be sent. Try again.';
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
          const Text('Sent for approval', key: Key('party-edit-sent'), style: TextStyle(fontSize: 18, fontWeight: FontWeight.w600)),
          const Padding(padding: EdgeInsets.symmetric(vertical: 8), child: Text('It is waiting in Pending. Nothing changes until you approve it.')),
          FilledButton(key: const Key('party-edit-done'), onPressed: widget.onClose, child: const Text('Done')),
        ]),
      );
    }
    return SafeArea(
      child: ListView(padding: const EdgeInsets.all(12), children: [
        const Text('Change customer or supplier', style: TextStyle(fontSize: 18, fontWeight: FontWeight.w600)),
        const SizedBox(height: 8),
        TextField(key: const Key('party-edit-name'), controller: _name, decoration: const InputDecoration(labelText: 'Name')),
        TextField(key: const Key('party-edit-phone'), controller: _phone, keyboardType: TextInputType.phone, decoration: const InputDecoration(labelText: 'Phone')),
        TextField(key: const Key('party-edit-email'), controller: _email, keyboardType: TextInputType.emailAddress, decoration: const InputDecoration(labelText: 'Email')),
        TextField(key: const Key('party-edit-address'), controller: _address, decoration: const InputDecoration(labelText: 'Address')),
        if (widget.party.isCustomer) TextField(key: const Key('party-edit-terms'), controller: _terms, keyboardType: TextInputType.number, decoration: const InputDecoration(labelText: 'Payment term in days')),
        if (_problem != null) Padding(padding: const EdgeInsets.only(top: 8), child: Text(_problem!, key: const Key('party-edit-problem'), style: const TextStyle(color: Color(0xFFB3261E)))),
        const SizedBox(height: 12),
        FilledButton(key: const Key('party-edit-send'), onPressed: _sending ? null : _send, child: Text(_sending ? 'Sending…' : 'Send for approval')),
        TextButton(key: const Key('party-edit-cancel'), onPressed: widget.onClose, child: const Text('Cancel')),
      ]),
    );
  }
}
