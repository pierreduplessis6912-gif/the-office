// The invoices room: every customer invoice as the engine lists it (GET /engine/invoices), newest first, with what is still owed on each and the engine's total owing. It only READS; an invoice is issued through
// a held proposal the person approves. Nothing here computes a figure.
import 'package:flutter/material.dart';

import '../slice_model.dart' show randFromMinor;
import 'assistant_model.dart';
import 'engine_api.dart';

class InvoicesRoom extends StatefulWidget {
  final EngineApi api;
  const InvoicesRoom({super.key, required this.api});

  @override
  State<InvoicesRoom> createState() => _InvoicesRoomState();
}

class _InvoicesRoomState extends State<InvoicesRoom> {
  InvoiceList? _list;
  bool _loading = true;
  bool _failed = false;

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
    InvoiceList? list;
    try {
      final response = await widget.api.invoices();
      list = parseInvoiceList(response.status, response.body);
    } catch (_) {
      list = null;
    }
    if (!mounted) return;
    setState(() {
      _list = list;
      _failed = list == null;
      _loading = false;
    });
  }

  Widget _row(InvoiceEntry i) {
    const grey = TextStyle(fontSize: 12, color: Color(0xFF8A8A90));
    final title = i.number == null ? i.customer : '${i.customer} · #${i.number}';
    final owing = i.outstandingMinor > 0;
    return Card(
      key: Key('invoice-row-${i.id}'),
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(title, style: const TextStyle(fontWeight: FontWeight.w600)),
              if (i.issuedOn.isNotEmpty) Text('Issued ${i.issuedOn}', style: grey),
            ]),
          ),
          Column(crossAxisAlignment: CrossAxisAlignment.end, children: [
            Text(randFromMinor(i.grossMinor)),
            Text(owing ? 'Owing ${randFromMinor(i.outstandingMinor)}' : 'Paid', style: grey),
          ]),
        ]),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final list = _list;
    Widget body;
    if (_loading) {
      body = const Padding(padding: EdgeInsets.all(12), child: Text('Reading…', style: TextStyle(color: Color(0xFF8A8A90))));
    } else if (_failed || list == null) {
      body = const Padding(padding: EdgeInsets.all(12), child: Text('The invoices could not be read. Try again.', key: Key('invoices-error')));
    } else if (list.rows.isEmpty) {
      body = const Padding(padding: EdgeInsets.all(12), child: Text('No invoices yet.', key: Key('invoices-empty')));
    } else {
      body = Column(children: [
        Padding(padding: const EdgeInsets.only(bottom: 8), child: Align(alignment: Alignment.centerLeft, child: Text('Owing in total: ${randFromMinor(list.owingMinor)}', key: const Key('invoices-owing'), style: const TextStyle(fontWeight: FontWeight.w600)))),
        for (final i in list.rows) _row(i),
        if (list.truncated) const Text('Showing the latest 50.', key: Key('invoices-truncated'), style: TextStyle(fontSize: 12, color: Color(0xFF8A8A90))),
      ]);
    }
    return SafeArea(
      child: ListView(padding: const EdgeInsets.all(12), children: [
        Row(children: [
          const Expanded(child: Text('Invoices', style: TextStyle(fontSize: 18, fontWeight: FontWeight.w600))),
          IconButton(key: const Key('invoices-refresh'), tooltip: 'Check again', icon: const Icon(Icons.refresh), onPressed: _loading ? null : _load),
        ]),
        body,
      ]),
    );
  }
}
