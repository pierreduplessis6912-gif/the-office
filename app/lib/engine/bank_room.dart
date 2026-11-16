// The bank room: whether the bank account agrees with the latest bank statement, what is still open on each side, and this month's cash flow. READ ONLY, and the app works out nothing: every
// figure arrives from the engine in minor units and is only formatted here; the engine decides which month. Matching a statement line to a payment is approved through the assistant, not here.
import 'package:flutter/material.dart';
import '../slice_model.dart';
import 'assistant_model.dart';
import 'engine_api.dart';

class BankRoom extends StatefulWidget {
  final EngineApi api;
  const BankRoom({super.key, required this.api});
  @override
  State<BankRoom> createState() => _BankRoomState();
}

class _BankRoomState extends State<BankRoom> {
  bool _loading = true;
  bool _failed = false;
  bool _noStatement = false;
  BankRec? _rec;
  CashFlow? _flow;
  List<BankAccountEntry> _accounts = <BankAccountEntry>[];

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() { _loading = true; _failed = false; });
    try {
      final r = await widget.api.bankReconciliation();
      final f = await widget.api.cashFlow('this_month');
      final a = await widget.api.bankAccounts();
      if (!mounted) return;
      setState(() {
        _noStatement = bankRecHasNoStatement(r.status, r.body);
        _rec = parseBankRec(r.status, r.body);
        _flow = parseCashFlow(f.status, f.body);
        _accounts = parseBankAccounts(a.status, a.body) ?? <BankAccountEntry>[];
        _failed = !_noStatement && _rec == null && _flow == null;
        _loading = false;
      });
    } catch (_) {
      if (!mounted) return;
      setState(() { _failed = true; _loading = false; });
    }
  }

  Widget _heading(String t) => Padding(padding: const EdgeInsets.only(top: 16, bottom: 4), child: Text(t, style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w600)));

  Widget _row(String label, int minor, {bool bold = false}) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 2),
        child: Row(children: [
          Expanded(child: Text(label, style: TextStyle(fontWeight: bold ? FontWeight.w600 : FontWeight.w400))),
          Text(randFromMinor(minor), style: TextStyle(fontWeight: bold ? FontWeight.w600 : FontWeight.w400)),
        ]),
      );

  List<Widget> _items(List<BankItem> l) => <Widget>[for (final x in l) _row('${x.date}  ${x.what}', x.amountMinor)];

  @override
  Widget build(BuildContext context) {
    final Widget body;
    if (_loading) {
      body = const Padding(padding: EdgeInsets.all(24), child: Center(child: CircularProgressIndicator()));
    } else if (_failed) {
      body = const Padding(key: Key('bank-error'), padding: EdgeInsets.all(16), child: Text('The bank could not be read just now. Check again in a moment.'));
    } else {
      final r = _rec, f = _flow;
      body = Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        if (_accounts.length > 1) ...[
          _heading('Bank accounts'),
          for (final x in _accounts) Padding(key: Key('bank-account-${x.id}'), padding: const EdgeInsets.symmetric(vertical: 2), child: Row(children: [Expanded(child: Text(x.name)), Text(randFromMinor(x.balanceMinor))])),
          const Text('The statement check below is for the main account. Ask the assistant about another account, for example "is savings reconciled?".', key: Key('bank-main-only'), style: TextStyle(fontSize: 12, color: Color(0xFF8A8A90))),
        ],
        if (_noStatement)
          const Padding(key: Key('bank-no-statement'), padding: EdgeInsets.only(top: 12), child: Text('No bank statement has been brought in yet.'))
        else if (r != null) ...[
          _heading('Bank against the statement, to ${r.periodTo}'),
          _row('The books say', r.ledgerMinor),
          _row('The statement says', r.statementMinor),
          if (r.reconciled) const Text('Reconciled: nothing is open.', key: Key('bank-reconciled')),
          if (r.unexplainedMinor != 0) ...[_row('Not explained', r.unexplainedMinor, bold: true), const Text('This difference is not explained by anything open.', key: Key('bank-unexplained'))],
          if (r.notOnStatement.isNotEmpty) ...[_heading('In the books, not yet on the statement'), ..._items(r.notOnStatement)],
          if (r.notInBooks.isNotEmpty) ...[_heading('On the statement, not yet in the books'), ..._items(r.notInBooks)],
        ] else
          const Text('The reconciliation could not be read.', key: Key('bank-rec-error')),
        if (f != null) ...[
          _heading('Cash flow, ${f.from} to ${f.to}'),
          _row('Opening', f.openingMinor),
          for (final x in f.inflows) _row('In: ${x.name}', x.amountMinor),
          for (final x in f.outflows) _row('Out: ${x.name}', x.amountMinor),
          _row('Closing', f.closingMinor, bold: true),
        ] else
          const Text('Cash flow could not be read.', key: Key('bank-flow-error')),
      ]);
    }
    return SafeArea(
      child: ListView(padding: const EdgeInsets.all(12), children: [
        Row(children: [
          const Expanded(child: Text('The bank', style: TextStyle(fontSize: 18, fontWeight: FontWeight.w600))),
          IconButton(key: const Key('bank-refresh'), tooltip: 'Check again', icon: const Icon(Icons.refresh), onPressed: _loading ? null : _load),
        ]),
        body,
      ]),
    );
  }
}
