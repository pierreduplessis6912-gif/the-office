// The "make a job" form. It fills the payload the assistant would (job.create) and sends it to be HELD; nothing is made until the owner approves it. The customer comes from the customers the engine lists, the
// person (optional) from the installers. The engine refuses the same work twice for a customer and shows its own reason. The app only turns what was typed into the engine's shapes.
import 'package:flutter/material.dart';

import '../slice_model.dart' show parseProposal;
import 'assistant_model.dart';
import 'engine_api.dart';

class JobForm extends StatefulWidget {
  final EngineApi api;
  final VoidCallback onClose;
  final DateTime Function()? clock;
  const JobForm({super.key, required this.api, required this.onClose, this.clock});

  @override
  State<JobForm> createState() => _JobFormState();
}

class _JobFormState extends State<JobForm> {
  final _what = TextEditingController();
  final _site = TextEditingController();
  final _date = TextEditingController();
  final _reference = TextEditingController();
  List<PartyEntry> _customers = <PartyEntry>[];
  List<PartyEntry> _installers = <PartyEntry>[];
  bool _loading = true;
  bool _failed = false;
  PartyEntry? _customer;
  PartyEntry? _installer;
  bool _sending = false;
  bool _sent = false;
  String? _problem;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _what.dispose();
    _site.dispose();
    _date.dispose();
    _reference.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    try {
      final p = await widget.api.parties();
      final list = parsePartyList(p.status, p.body);
      if (!mounted) return;
      setState(() {
        _customers = (list ?? <PartyEntry>[]).where((x) => x.isCustomer).toList();
        _installers = (list ?? <PartyEntry>[]).where((x) => x.roles.contains('installer')).toList();
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
    final what = _what.text.trim();
    if (what.isEmpty) return setState(() => _problem = 'Say what the work is.');
    final date = _date.text.trim();
    if (date.isNotEmpty && !RegExp(r'^\d{4}-\d{2}-\d{2}$').hasMatch(date)) return setState(() => _problem = 'The date must look like 2026-11-20, or be left empty.');
    final site = _site.text.trim();
    final ref = _reference.text.trim();
    final payload = <String, Object?>{
      'partyId': c.id,
      'description': what,
      if (site.isNotEmpty) 'siteAddress': site,
      if (date.isNotEmpty) 'scheduledOn': date,
      if (_installer != null) 'assigneeId': _installer!.id,
      if (ref.isNotEmpty) 'reference': ref,
    };
    setState(() {
      _sending = true;
      _problem = null;
    });
    String? problem;
    bool held = false;
    try {
      final r = await widget.api.propose('job.create', payload, 'Added from the Make a job form');
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
          const Text('Sent for approval', key: Key('job-form-sent'), style: TextStyle(fontSize: 18, fontWeight: FontWeight.w600)),
          const Padding(padding: EdgeInsets.symmetric(vertical: 8), child: Text('It is waiting in Pending. Nothing is made until you approve it.')),
          FilledButton(key: const Key('job-form-done'), onPressed: widget.onClose, child: const Text('Done')),
        ]),
      );
    }
    if (_loading) return const SafeArea(child: Padding(padding: EdgeInsets.all(12), child: Text('Reading…', style: TextStyle(color: Color(0xFF8A8A90)))));
    if (_failed) {
      return SafeArea(
        child: ListView(padding: const EdgeInsets.all(12), children: [
          const Text('The customers could not be read. Try again.', key: Key('job-form-error')),
          TextButton(key: const Key('job-form-cancel'), onPressed: widget.onClose, child: const Text('Close')),
        ]),
      );
    }
    return SafeArea(
      child: ListView(padding: const EdgeInsets.all(12), children: [
        const Text('Make a job', style: TextStyle(fontSize: 18, fontWeight: FontWeight.w600)),
        const SizedBox(height: 8),
        DropdownButtonFormField<int>(
          key: const Key('job-form-customer'),
          decoration: const InputDecoration(labelText: 'Customer'),
          initialValue: _customer?.id,
          items: [for (final c in _customers) DropdownMenuItem<int>(value: c.id, child: Text(c.name))],
          onChanged: (id) => setState(() => _customer = id == null ? null : _customers.firstWhere((c) => c.id == id)),
        ),
        TextField(key: const Key('job-form-what'), controller: _what, decoration: const InputDecoration(labelText: 'The work (for example, lounge floor)')),
        TextField(key: const Key('job-form-site'), controller: _site, decoration: const InputDecoration(labelText: 'Site address (optional)')),
        TextField(key: const Key('job-form-date'), controller: _date, decoration: const InputDecoration(labelText: 'Date (YYYY-MM-DD, optional)')),
        if (_installers.isNotEmpty)
          DropdownButtonFormField<int>(
            key: const Key('job-form-installer'),
            decoration: const InputDecoration(labelText: 'Who does it (optional)'),
            initialValue: _installer?.id,
            items: [for (final c in _installers) DropdownMenuItem<int>(value: c.id, child: Text(c.name))],
            onChanged: (id) => setState(() => _installer = id == null ? null : _installers.firstWhere((c) => c.id == id)),
          ),
        TextField(key: const Key('job-form-reference'), controller: _reference, decoration: const InputDecoration(labelText: 'Reference (optional)')),
        if (_problem != null) Padding(padding: const EdgeInsets.only(top: 8), child: Text(_problem!, key: const Key('job-form-problem'), style: const TextStyle(color: Color(0xFFB3261E)))),
        const SizedBox(height: 12),
        Row(children: [
          FilledButton(key: const Key('job-form-send'), onPressed: _sending ? null : _send, child: Text(_sending ? 'Sending…' : 'Send for approval')),
          const SizedBox(width: 8),
          TextButton(key: const Key('job-form-cancel'), onPressed: widget.onClose, child: const Text('Cancel')),
        ]),
      ]),
    );
  }
}
