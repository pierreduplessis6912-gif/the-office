// The "make an invoice" form. The engine issues an invoice from a DRAFT: a working copy that is not a business fact and needs no approval (POST then PUT /engine/drafts). The form opens the draft, saves the lines
// from the line editor into it, and then proposes invoice.issue, which is HELD: nothing is issued until the owner approves it. The engine checks the draft field by field and works out the totals; its reason is
// shown. Currency is rand. The app only turns what was typed into the engine's shapes and refuses what is plainly empty.
import 'package:flutter/material.dart';

import '../slice_model.dart' show parseProposal;
import 'assistant_model.dart';
import 'engine_api.dart';
import 'line_editor.dart';

class InvoiceForm extends StatefulWidget {
  final EngineApi api;
  final VoidCallback onClose;
  final DateTime Function()? clock;
  const InvoiceForm({super.key, required this.api, required this.onClose, this.clock});

  @override
  State<InvoiceForm> createState() => _InvoiceFormState();
}

class _InvoiceFormState extends State<InvoiceForm> {
  final _lines = LineEditorController();
  final _reference = TextEditingController();
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
    final contents = <String, Object?>{
      'currency': 'ZAR',
      'issuedOn': _date.text.trim(),
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
      final opened = await widget.api.createDraft(c.id);
      final ob = opened.body;
      final draftId = opened.status == 200 && ob is Map ? ob['id'] : null;
      final openedVersion = opened.status == 200 && ob is Map ? ob['version'] : null;
      if (draftId is! int || openedVersion is! int) {
        problem = _reason(opened) ?? 'The invoice could not be started. Try again.';
      } else {
        final saved = await widget.api.saveDraft(draftId, openedVersion, c.id, contents);
        final sb = saved.body;
        final version = saved.status == 200 && sb is Map ? sb['version'] : null;
        final validation = sb is Map ? sb['validation'] : null;
        if (version is! int || validation is! Map) {
          problem = _reason(saved) ?? 'The invoice could not be saved. Try again.';
        } else if (validation['ok'] != true) {
          problem = _firstError(validation) ?? 'The invoice is not ready yet.';
        } else {
          final r = await widget.api.propose('invoice.issue', <String, Object?>{'draftId': draftId, 'expectedVersion': version}, 'Added from the Make an invoice form');
          final p = parseProposal(r.status, r.body);
          held = p.held;
          if (!held) problem = p.message ?? 'That could not be sent. Try again.';
        }
      }
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

  String? _reason(EngineResponse r) {
    final b = r.body;
    return b is Map && b['message'] is String ? b['message'] as String : null;
  }

  String? _firstError(Map<Object?, Object?> validation) {
    final errors = validation['errors'];
    if (errors is List && errors.isNotEmpty && errors.first is Map) {
      final m = (errors.first as Map)['message'];
      if (m is String && m.isNotEmpty) return m;
    }
    return null;
  }

  @override
  Widget build(BuildContext context) {
    if (_sent) {
      return SafeArea(
        child: ListView(padding: const EdgeInsets.all(12), children: [
          const Text('Sent for approval', key: Key('invoice-form-sent'), style: TextStyle(fontSize: 18, fontWeight: FontWeight.w600)),
          const Padding(padding: EdgeInsets.symmetric(vertical: 8), child: Text('It is waiting in Pending, where you will see the invoice it would issue. Nothing is issued until you approve it.')),
          FilledButton(key: const Key('invoice-form-done'), onPressed: widget.onClose, child: const Text('Done')),
        ]),
      );
    }
    if (_loading) return const SafeArea(child: Padding(padding: EdgeInsets.all(12), child: Text('Reading…', style: TextStyle(color: Color(0xFF8A8A90)))));
    if (_failed) {
      return SafeArea(
        child: ListView(padding: const EdgeInsets.all(12), children: [
          const Text('The customers could not be read. Try again.', key: Key('invoice-form-error')),
          TextButton(key: const Key('invoice-form-cancel'), onPressed: widget.onClose, child: const Text('Close')),
        ]),
      );
    }
    return SafeArea(
      child: ListView(padding: const EdgeInsets.all(12), children: [
        const Text('Make an invoice', style: TextStyle(fontSize: 18, fontWeight: FontWeight.w600)),
        const SizedBox(height: 8),
        DropdownButtonFormField<int>(
          key: const Key('invoice-form-customer'),
          decoration: const InputDecoration(labelText: 'Customer'),
          initialValue: _customer?.id,
          items: [for (final c in _customers) DropdownMenuItem<int>(value: c.id, child: Text(c.name))],
          onChanged: (id) => setState(() => _customer = id == null ? null : _customers.firstWhere((c) => c.id == id)),
        ),
        TextField(key: const Key('invoice-form-date'), controller: _date, decoration: const InputDecoration(labelText: 'Date (YYYY-MM-DD)')),
        TextField(key: const Key('invoice-form-reference'), controller: _reference, decoration: const InputDecoration(labelText: 'Reference (optional)')),
        const SizedBox(height: 8),
        LineEditor(controller: _lines, keyPrefix: 'invoice-form'),
        if (_problem != null) Padding(padding: const EdgeInsets.only(top: 8), child: Text(_problem!, key: const Key('invoice-form-problem'), style: const TextStyle(color: Color(0xFFB3261E)))),
        const SizedBox(height: 12),
        Row(children: [
          FilledButton(key: const Key('invoice-form-send'), onPressed: _sending ? null : _send, child: Text(_sending ? 'Sending…' : 'Send for approval')),
          const SizedBox(width: 8),
          TextButton(key: const Key('invoice-form-cancel'), onPressed: widget.onClose, child: const Text('Cancel')),
        ]),
      ]),
    );
  }
}
