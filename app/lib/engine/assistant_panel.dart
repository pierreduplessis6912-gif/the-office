// The assistant screen: a typed sentence goes to the engine's interpreter (EngineApi.interpret); the engine answers a read, HOLDS a write for a person (shown with Approve and Decline), or says it did not understand. The screen computes
// nothing: it formats what the engine returned (assistant_model.dart). It talks only to the EngineApi, so it runs on recorded answers in the demo and on the real client when one is connected (a separate step that needs Pierre's approval).
import 'package:flutter/material.dart';

import '../slice_model.dart' show parseRecord, randFromMinor;
import 'assistant_model.dart';
import 'engine_api.dart';

class _Turn {
  final String said;
  AssistantTurn? turn;
  HeldAction? held;
  Map<int, String> names = <int, String>{};
  String? decision;
  bool decided = false;
  bool working = false;
  _Turn(this.said);
}

class AssistantPanel extends StatefulWidget {
  final EngineApi api;
  final String? footnote;
  const AssistantPanel({super.key, required this.api, this.footnote});

  @override
  State<AssistantPanel> createState() => _AssistantPanelState();
}

class _AssistantPanelState extends State<AssistantPanel> {
  final TextEditingController _controller = TextEditingController();
  final List<_Turn> _turns = <_Turn>[];
  bool _asking = false;

  Future<void> _ask() async {
    final text = _controller.text.trim();
    if (text.isEmpty || _asking) return;
    _controller.clear();
    final t = _Turn(text);
    setState(() {
      _turns.insert(0, t);
      _asking = true;
    });
    AssistantTurn turn;
    try {
      final response = await widget.api.interpret(text);
      turn = parseInterpret(response.status, response.body);
    } catch (_) {
      turn = const AssistantTurn.unusable();
    }
    HeldAction? held;
    final names = <int, String>{};
    if (turn.kind == AssistantKind.held && turn.actionId != null) {
      try {
        final response = await widget.api.pending();
        held = parseHeld(response.status, response.body, turn.actionId!);
        final supplier = held == null ? null : held.payload['supplierId'];
        if (supplier is int) {
          final record = await widget.api.record('party', supplier);
          final parsed = parseRecord(record.status, record.body);
          if (parsed != null) names[supplier] = parsed.title;
        }
      } catch (_) {
        held = null;
      }
    }
    if (!mounted) return;
    setState(() {
      t.turn = turn;
      t.held = held;
      t.names = names;
      _asking = false;
    });
  }

  Future<void> _decide(_Turn t, {required bool confirm}) async {
    final held = t.held;
    if (held == null || t.decided || t.working) return;
    setState(() => t.working = true);
    AssistantOutcome outcome;
    try {
      final response = confirm ? await widget.api.confirm(held.id) : await widget.api.reject(held.id);
      outcome = parseDecision(response.status, response.body, confirmed: confirm);
    } catch (_) {
      outcome = const AssistantOutcome(ok: false, message: 'The Office could not be reached. Nothing was changed.');
    }
    if (!mounted) return;
    setState(() {
      t.working = false;
      t.decided = outcome.ok;
      t.decision = outcome.message;
    });
  }

  Widget _card(_Turn t) {
    final turn = t.turn;
    if (turn == null) return const Padding(padding: EdgeInsets.all(12), child: Text('Reading that…', style: TextStyle(color: Color(0xFF8A8A90))));
    switch (turn.kind) {
      case AssistantKind.parties:
      case AssistantKind.ambiguous:
        if (turn.parties.isEmpty) return const Padding(padding: EdgeInsets.all(12), child: Text('There is nobody by that name.'));
        return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          if (turn.kind == AssistantKind.ambiguous) const Padding(padding: EdgeInsets.fromLTRB(12, 12, 12, 0), child: Text('More than one matches. Which one do you mean?')),
          for (final p in turn.parties) ListTile(key: Key('party-${p.id}'), dense: true, title: Text(p.name), subtitle: Text(p.roles)),
        ]);
      case AssistantKind.vat:
        final v = turn.vat!;
        Widget row(String label, int minor) => Padding(padding: const EdgeInsets.symmetric(vertical: 2), child: Row(mainAxisAlignment: MainAxisAlignment.spaceBetween, children: [Text(label), Text(randFromMinor(minor))]));
        return Padding(padding: const EdgeInsets.all(12), child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text('VAT ${v.from} to ${v.to}${v.locked ? ' (locked)' : ''}', style: const TextStyle(fontWeight: FontWeight.w600)),
          const SizedBox(height: 6),
          row('Standard-rated supplies, with VAT (field 1)', v.field1Minor),
          row('Output tax (field 4)', v.field4Minor),
          row('Input tax', v.inputTaxMinor),
          row('Net VAT', v.netVatMinor),
          if (v.incompleteDocuments > 0) Padding(padding: const EdgeInsets.only(top: 6), child: Text('${v.incompleteDocuments} document(s) still lack tax particulars.', style: const TextStyle(color: Color(0xFFC9A227)))),
          for (final n in v.notes) Padding(padding: const EdgeInsets.only(top: 4), child: Text(n, style: const TextStyle(fontSize: 12, color: Color(0xFF8A8A90)))),
        ]));
      case AssistantKind.expenses:
        if (turn.expenses.isEmpty) return const Padding(padding: EdgeInsets.all(12), child: Text('No expenses match.'));
        return Column(children: [
          for (final e in turn.expenses) ListTile(key: Key('expense-${e.id}'), dense: true, title: Text('${e.supplier} · ${e.category.replaceAll('_', ' ')}'), subtitle: Text('${e.incurredOn} · input tax ${e.claimable ? 'claimable' : 'not claimable'}'), trailing: Text(randFromMinor(e.grossMinor))),
        ]);
      case AssistantKind.held:
        final held = t.held;
        return Padding(padding: const EdgeInsets.all(12), child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(held == null ? 'Waiting for your approval' : heldTitle(held.type), style: const TextStyle(fontWeight: FontWeight.w600)),
          const SizedBox(height: 4),
          const Text('Nothing is recorded until you approve it.', style: TextStyle(fontSize: 12, color: Color(0xFF8A8A90))),
          if (held != null) for (final l in heldLines(held, names: t.names)) Padding(padding: const EdgeInsets.symmetric(vertical: 2), child: Row(mainAxisAlignment: MainAxisAlignment.spaceBetween, children: [Text(l.label), Flexible(child: Text(l.value, textAlign: TextAlign.right))])),
          if (t.decision != null) Padding(padding: const EdgeInsets.only(top: 8), child: Text(t.decision!, key: const Key('decision-line'))),
          if (held != null && !t.decided) Padding(padding: const EdgeInsets.only(top: 8), child: Row(children: [
            FilledButton(key: Key('approve-${held.id}'), onPressed: t.working ? null : () => _decide(t, confirm: true), child: const Text('Approve')),
            const SizedBox(width: 8),
            OutlinedButton(key: Key('decline-${held.id}'), onPressed: t.working ? null : () => _decide(t, confirm: false), child: const Text('Decline')),
          ])),
        ]));
      case AssistantKind.notUnderstood:
        return const Padding(padding: EdgeInsets.all(12), child: Text('I did not understand that as something I can do, so nothing was done.'));
      case AssistantKind.refused:
        return Padding(padding: const EdgeInsets.all(12), child: Text(turn.message ?? 'That was not possible.'));
      case AssistantKind.unusable:
        return const Padding(padding: EdgeInsets.all(12), child: Text('The Office did not answer that clearly.'));
    }
  }

  @override
  Widget build(BuildContext context) {
    return Column(children: [
      Padding(padding: const EdgeInsets.fromLTRB(12, 12, 12, 4), child: Row(children: [
        Expanded(child: TextField(key: const Key('assistant-field'), controller: _controller, textInputAction: TextInputAction.send, onSubmitted: (_) => _ask(), decoration: const InputDecoration(hintText: 'e.g. “What is my VAT this month?”', border: OutlineInputBorder()))),
        const SizedBox(width: 8),
        IconButton(key: const Key('assistant-send'), onPressed: _asking ? null : _ask, icon: const Icon(Icons.send)),
      ])),
      if (widget.footnote != null) Padding(padding: const EdgeInsets.symmetric(horizontal: 12), child: Align(alignment: Alignment.centerLeft, child: Text(widget.footnote!, style: const TextStyle(fontSize: 11, color: Color(0xFF8A8A90))))),
      Expanded(child: ListView(padding: const EdgeInsets.all(12), children: [
        for (final t in _turns) Card(key: ValueKey<_Turn>(t), child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Padding(padding: const EdgeInsets.fromLTRB(12, 10, 12, 0), child: Text(t.said, style: const TextStyle(color: Color(0xFF8A8A90), fontSize: 12))),
          _card(t),
        ])),
      ])),
    ]);
  }
}
