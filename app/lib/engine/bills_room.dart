// The bills room: the supplier bills still to be paid, as the engine lists them (GET /engine/supplier-invoices?status=outstanding): supplier, the supplier's invoice number, due date, what is still owed and the bill
// total. It only READS; a bill is recorded or paid through a held proposal the person approves. Nothing here computes a figure.
import 'package:flutter/material.dart';

import '../slice_model.dart' show randFromMinor;
import 'assistant_model.dart';
import 'engine_api.dart';
import 'supplier_payment_form.dart';

class BillsRoom extends StatefulWidget {
  final EngineApi api;
  const BillsRoom({super.key, required this.api});

  @override
  State<BillsRoom> createState() => _BillsRoomState();
}

class _BillsRoomState extends State<BillsRoom> {
  List<AssistantBill> _rows = <AssistantBill>[];
  bool _loading = true;
  bool _failed = false;
  bool _paying = false;

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
    List<AssistantBill>? rows;
    try {
      final response = await widget.api.bills();
      rows = parseBillList(response.status, response.body);
    } catch (_) {
      rows = null;
    }
    if (!mounted) return;
    setState(() {
      _rows = rows ?? <AssistantBill>[];
      _failed = rows == null;
      _loading = false;
    });
  }

  Widget _row(AssistantBill b) {
    const grey = TextStyle(fontSize: 12, color: Color(0xFF8A8A90));
    final ref = b.invoiceNumber.isEmpty ? b.supplier : '${b.supplier} · ${b.invoiceNumber}';
    return Card(
      key: Key('bill-row-${b.id}'),
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(ref, style: const TextStyle(fontWeight: FontWeight.w600)),
              if (b.dueOn.isNotEmpty) Text('Due ${b.dueOn}', style: grey),
            ]),
          ),
          Column(crossAxisAlignment: CrossAxisAlignment.end, children: [
            Text('${randFromMinor(b.outstandingMinor)} owed'),
            Text('of ${randFromMinor(b.grossMinor)}', style: grey),
          ]),
        ]),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    if (_paying) return SupplierPaymentForm(key: const ValueKey<String>('supplier-payment-form'), api: widget.api, onClose: () { setState(() => _paying = false); _load(); });
    Widget body;
    if (_loading) {
      body = const Padding(padding: EdgeInsets.all(12), child: Text('Reading…', style: TextStyle(color: Color(0xFF8A8A90))));
    } else if (_failed) {
      body = const Padding(padding: EdgeInsets.all(12), child: Text('The bills could not be read. Try again.', key: Key('bills-error')));
    } else if (_rows.isEmpty) {
      body = const Padding(padding: EdgeInsets.all(12), child: Text('No bills are waiting to be paid.', key: Key('bills-empty')));
    } else {
      body = Column(children: [for (final b in _rows) _row(b)]);
    }
    return SafeArea(
      child: ListView(padding: const EdgeInsets.all(12), children: [
        Row(children: [
          const Expanded(child: Text('Bills to pay', style: TextStyle(fontSize: 18, fontWeight: FontWeight.w600))),
          IconButton(key: const Key('bills-pay'), tooltip: 'Pay a supplier', icon: const Icon(Icons.add), onPressed: () => setState(() => _paying = true)),
          IconButton(key: const Key('bills-refresh'), tooltip: 'Check again', icon: const Icon(Icons.refresh), onPressed: _loading ? null : _load),
        ]),
        body,
      ]),
    );
  }
}
