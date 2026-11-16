// The expenses room: what the business has bought and paid for, as the engine lists it (GET /engine/expenses): supplier, category, date, total, and whether the VAT on it can be claimed. It only READS. An
// expense is recorded or voided through a held proposal the person approves (the assistant and the approvals room); nothing here computes a figure or changes anything.
import 'package:flutter/material.dart';

import '../slice_model.dart' show randFromMinor;
import 'assistant_model.dart';
import 'engine_api.dart';
import 'expense_form.dart';

class ExpensesRoom extends StatefulWidget {
  final EngineApi api;
  const ExpensesRoom({super.key, required this.api});

  @override
  State<ExpensesRoom> createState() => _ExpensesRoomState();
}

class _ExpensesRoomState extends State<ExpensesRoom> {
  List<AssistantExpense> _rows = <AssistantExpense>[];
  bool _loading = true;
  bool _failed = false;
  bool _adding = false;

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
    List<AssistantExpense>? rows;
    try {
      final response = await widget.api.expenses();
      rows = parseExpenseList(response.status, response.body);
    } catch (_) {
      rows = null;
    }
    if (!mounted) return;
    setState(() {
      _rows = rows ?? <AssistantExpense>[];
      _failed = rows == null;
      _loading = false;
    });
  }

  Widget _row(AssistantExpense e) {
    final category = e.category.replaceAll('_', ' ');
    return Card(
      key: Key('expense-row-${e.id}'),
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(category.isEmpty ? e.supplier : '${e.supplier} · $category', style: const TextStyle(fontWeight: FontWeight.w600)),
              const SizedBox(height: 2),
              Text(e.incurredOn, style: const TextStyle(fontSize: 12, color: Color(0xFF8A8A90))),
            ]),
          ),
          Column(crossAxisAlignment: CrossAxisAlignment.end, children: [
            Text(randFromMinor(e.grossMinor)),
            const SizedBox(height: 2),
            Text(e.claimable ? 'VAT claimable' : 'VAT not claimable', style: const TextStyle(fontSize: 12, color: Color(0xFF8A8A90))),
          ]),
        ]),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    if (_adding) return ExpenseForm(key: const ValueKey<String>('expense-form'), api: widget.api, onClose: () { setState(() => _adding = false); _load(); });
    Widget body;
    if (_loading) {
      body = const Padding(padding: EdgeInsets.all(12), child: Text('Reading…', style: TextStyle(color: Color(0xFF8A8A90))));
    } else if (_failed) {
      body = const Padding(padding: EdgeInsets.all(12), child: Text('The expenses could not be read. Try again.', key: Key('expenses-error')));
    } else if (_rows.isEmpty) {
      body = const Padding(padding: EdgeInsets.all(12), child: Text('No expenses have been recorded yet.', key: Key('expenses-empty')));
    } else {
      body = Column(children: [for (final e in _rows) _row(e)]);
    }
    return SafeArea(
      child: ListView(padding: const EdgeInsets.all(12), children: [
        Row(children: [
          const Expanded(child: Text('Expenses', style: TextStyle(fontSize: 18, fontWeight: FontWeight.w600))),
          IconButton(key: const Key('expenses-add'), tooltip: 'Record an expense', icon: const Icon(Icons.add), onPressed: () => setState(() => _adding = true)),
          IconButton(key: const Key('expenses-refresh'), tooltip: 'Check again', icon: const Icon(Icons.refresh), onPressed: _loading ? null : _load),
        ]),
        body,
      ]),
    );
  }
}
