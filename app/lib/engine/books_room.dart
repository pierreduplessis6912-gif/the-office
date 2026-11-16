// The books room: this month's profit and loss, what the business owns and owes today, and whether the books agree with the records. READ ONLY, and the app works out nothing:
// every figure arrives from the engine in minor units and is only formatted here; the engine decides which month and which day. An unreadable answer says so.
import 'package:flutter/material.dart';
import '../slice_model.dart';
import 'assistant_model.dart';
import 'engine_api.dart';

class BooksRoom extends StatefulWidget {
  final EngineApi api;
  const BooksRoom({super.key, required this.api});
  @override
  State<BooksRoom> createState() => _BooksRoomState();
}

class _BooksRoomState extends State<BooksRoom> {
  bool _loading = true;
  bool _failed = false;
  BookProfit? _profit;
  BookBalance? _balance;
  BookReconciliation? _recon;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() { _loading = true; _failed = false; });
    try {
      final p = await widget.api.profitAndLoss('this_month');
      final b = await widget.api.balanceSheet();
      final r = await widget.api.reconciliation();
      if (!mounted) return;
      setState(() {
        _profit = parseProfit(p.status, p.body);
        _balance = parseBalance(b.status, b.body);
        _recon = parseReconciliation(r.status, r.body);
        _failed = _profit == null && _balance == null && _recon == null;
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

  List<Widget> _lines(List<BookLine> l) => <Widget>[for (final x in l) _row(x.name, x.amountMinor)];

  @override
  Widget build(BuildContext context) {
    final Widget body;
    if (_loading) {
      body = const Padding(padding: EdgeInsets.all(24), child: Center(child: CircularProgressIndicator()));
    } else if (_failed) {
      body = const Padding(key: Key('books-error'), padding: EdgeInsets.all(16), child: Text('The books could not be read just now. Check again in a moment.'));
    } else {
      final p = _profit, b = _balance, r = _recon;
      final empty = (p == null || (p.income.isEmpty && p.costOfSales.isEmpty && p.expenses.isEmpty)) && (b == null || (b.assets.isEmpty && b.liabilities.isEmpty && b.equity.isEmpty));
      body = empty
          ? const Padding(key: Key('books-empty'), padding: EdgeInsets.all(16), child: Text('Nothing has been booked yet.'))
          : Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              if (p != null) ...[
                _heading('Profit and loss, ${p.from} to ${p.to}'),
                ..._lines(p.income),
                _row('Income', p.incomeMinor, bold: true),
                ..._lines(p.costOfSales),
                _row('Gross profit', p.grossProfitMinor, bold: true),
                ..._lines(p.expenses),
                _row('Profit', p.profitMinor, bold: true),
              ] else
                const Text('Profit and loss could not be read.', key: Key('books-profit-error')),
              if (b != null) ...[
                _heading('What the business owns and owes, ${b.asOf}'),
                ..._lines(b.assets),
                _row('Owns', b.assetsMinor, bold: true),
                ..._lines(b.liabilities),
                ..._lines(b.equity),
                _row('Earned so far', b.earningsMinor),
                if (!b.balanced) const Text('The books do not balance.', key: Key('books-unbalanced')),
              ] else
                const Text('The balance sheet could not be read.', key: Key('books-balance-error')),
              if (r != null) ...[
                _heading('Do the books agree with the records?'),
                if (r.agrees) const Text('Yes, everything agrees.', key: Key('books-agrees')) else ...[
                  for (final c in r.checks) if (c.differenceMinor != 0) _row(c.label, c.differenceMinor),
                ],
              ],
            ]);
    }
    return SafeArea(
      child: ListView(padding: const EdgeInsets.all(12), children: [
        Row(children: [
          const Expanded(child: Text('The books', style: TextStyle(fontSize: 18, fontWeight: FontWeight.w600))),
          IconButton(key: const Key('books-refresh'), tooltip: 'Check again', icon: const Icon(Icons.refresh), onPressed: _loading ? null : _load),
        ]),
        body,
      ]),
    );
  }
}
