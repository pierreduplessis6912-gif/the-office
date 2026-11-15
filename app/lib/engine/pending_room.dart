// The pending-approvals room: every engine action waiting for a person, with exactly what would be approved, and Approve and Decline. It is the shared held-action lifecycle (GET /actions/pending, confirm,
// reject) seen as a list instead of one card at a time. It computes nothing: the figures, titles and refusals are the engine's own (assistant_model.dart formats them). Nothing is recorded until Approve.
import 'package:flutter/material.dart';

import '../slice_model.dart' show parseRecord;
import 'assistant_model.dart';
import 'engine_api.dart';

class _Row {
  final HeldAction held;
  final Map<int, String> names;
  String? note;
  bool working = false;
  _Row(this.held, this.names);
}

class PendingRoom extends StatefulWidget {
  final EngineApi api;
  const PendingRoom({super.key, required this.api});

  @override
  State<PendingRoom> createState() => _PendingRoomState();
}

class _PendingRoomState extends State<PendingRoom> {
  List<_Row> _rows = <_Row>[];
  bool _loading = true;
  bool _failed = false;
  String? _banner;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _failed = false;
    });
    List<_Row> rows = <_Row>[];
    var failed = false;
    try {
      final response = await widget.api.pending();
      if (response.status != 200) {
        failed = true;
      } else {
        for (final held in parseHeldList(response.status, response.body)) {
          final names = <int, String>{};
          final supplier = held.payload['supplierId'];
          if (supplier is int) {
            try {
              final record = await widget.api.record('party', supplier);
              final parsed = parseRecord(record.status, record.body);
              if (parsed != null) names[supplier] = parsed.title;
            } catch (_) {
              // the number is shown instead of a name
            }
          }
          rows.add(_Row(held, names));
        }
      }
    } catch (_) {
      failed = true;
    }
    if (!mounted) return;
    setState(() {
      _rows = rows;
      _failed = failed;
      _loading = false;
    });
  }

  Future<void> _decide(_Row row, {required bool confirm}) async {
    if (row.working) return;
    setState(() => row.working = true);
    AssistantOutcome outcome;
    try {
      final response = confirm ? await widget.api.confirm(row.held.id) : await widget.api.reject(row.held.id);
      outcome = parseDecision(response.status, response.body, confirmed: confirm);
    } catch (_) {
      outcome = const AssistantOutcome(ok: false, message: 'The Office could not be reached. Nothing was changed.');
    }
    if (!mounted) return;
    setState(() {
      row.working = false;
      if (outcome.ok) {
        _rows = _rows.where((r) => r.held.id != row.held.id).toList();
        _banner = outcome.message;
        row.note = null;
      } else {
        row.note = outcome.message;
      }
    });
  }

  Widget _card(_Row row) {
    final held = row.held;
    return Card(
      key: Key('pending-${held.id}'),
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(heldTitle(held.type), style: const TextStyle(fontWeight: FontWeight.w600)),
          if (held.transcript.isNotEmpty) Padding(padding: const EdgeInsets.only(top: 2), child: Text('You said: “${held.transcript}”', style: const TextStyle(fontSize: 12, color: Color(0xFF8A8A90)))),
          const SizedBox(height: 6),
          for (final l in heldLines(held, names: row.names))
            Padding(padding: const EdgeInsets.symmetric(vertical: 2), child: Row(mainAxisAlignment: MainAxisAlignment.spaceBetween, children: [Text(l.label), Flexible(child: Text(l.value, textAlign: TextAlign.end))])),
          if (row.note != null) Padding(padding: const EdgeInsets.only(top: 8), child: Text(row.note!, key: Key('pending-note-${held.id}'))),
          Padding(
            padding: const EdgeInsets.only(top: 8),
            child: Row(children: [
              FilledButton(key: Key('pending-approve-${held.id}'), onPressed: row.working ? null : () => _decide(row, confirm: true), child: const Text('Approve')),
              const SizedBox(width: 8),
              OutlinedButton(key: Key('pending-decline-${held.id}'), onPressed: row.working ? null : () => _decide(row, confirm: false), child: const Text('Decline')),
            ]),
          ),
        ]),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    Widget body;
    if (_loading) {
      body = const Padding(padding: EdgeInsets.all(12), child: Text('Reading…', style: TextStyle(color: Color(0xFF8A8A90))));
    } else if (_failed) {
      body = const Padding(padding: EdgeInsets.all(12), child: Text('The list could not be read. Try again.', key: Key('pending-error')));
    } else if (_rows.isEmpty) {
      body = const Padding(padding: EdgeInsets.all(12), child: Text('Nothing is waiting for your approval.', key: Key('pending-empty')));
    } else {
      body = Column(children: [for (final r in _rows) _card(r)]);
    }
    return SafeArea(
      child: ListView(padding: const EdgeInsets.all(12), children: [
        Row(children: [
          const Expanded(child: Text('To approve', style: TextStyle(fontSize: 18, fontWeight: FontWeight.w600))),
          IconButton(key: const Key('pending-refresh'), tooltip: 'Check again', icon: const Icon(Icons.refresh), onPressed: _loading ? null : _load),
        ]),
        if (_banner != null) Padding(padding: const EdgeInsets.symmetric(vertical: 4), child: Text(_banner!, key: const Key('pending-banner'))),
        body,
      ]),
    );
  }
}
