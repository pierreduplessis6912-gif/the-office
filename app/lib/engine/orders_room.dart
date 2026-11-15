// The orders room: the purchase orders still waiting for goods, as the engine lists them (GET /engine/purchase-orders?status=outstanding): supplier, order number, date ordered, date expected and the total. It only
// READS; an order is raised, received or cancelled through a held proposal the person approves. Nothing here computes a figure.
import 'package:flutter/material.dart';

import '../slice_model.dart' show randFromMinor;
import 'assistant_model.dart';
import 'engine_api.dart';

class OrdersRoom extends StatefulWidget {
  final EngineApi api;
  const OrdersRoom({super.key, required this.api});

  @override
  State<OrdersRoom> createState() => _OrdersRoomState();
}

class _OrdersRoomState extends State<OrdersRoom> {
  List<AssistantOrder> _rows = <AssistantOrder>[];
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
    List<AssistantOrder>? rows;
    try {
      final response = await widget.api.orders();
      rows = parseOrderList(response.status, response.body);
    } catch (_) {
      rows = null;
    }
    if (!mounted) return;
    setState(() {
      _rows = rows ?? <AssistantOrder>[];
      _failed = rows == null;
      _loading = false;
    });
  }

  Widget _row(AssistantOrder o) {
    const grey = TextStyle(fontSize: 12, color: Color(0xFF8A8A90));
    final title = o.number == null ? o.supplier : '${o.supplier} · #${o.number}';
    return Card(
      key: Key('order-row-${o.id}'),
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(title, style: const TextStyle(fontWeight: FontWeight.w600)),
              if (o.orderedOn.isNotEmpty) Text('Ordered ${o.orderedOn}', style: grey),
              if (o.expectedOn.isNotEmpty) Text('Expected ${o.expectedOn}', style: grey),
            ]),
          ),
          Text(randFromMinor(o.grossMinor)),
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
      body = const Padding(padding: EdgeInsets.all(12), child: Text('The orders could not be read. Try again.', key: Key('orders-error')));
    } else if (_rows.isEmpty) {
      body = const Padding(padding: EdgeInsets.all(12), child: Text('No orders are waiting for goods.', key: Key('orders-empty')));
    } else {
      body = Column(children: [for (final o in _rows) _row(o)]);
    }
    return SafeArea(
      child: ListView(padding: const EdgeInsets.all(12), children: [
        Row(children: [
          const Expanded(child: Text('Orders waiting for goods', style: TextStyle(fontSize: 18, fontWeight: FontWeight.w600))),
          IconButton(key: const Key('orders-refresh'), tooltip: 'Check again', icon: const Icon(Icons.refresh), onPressed: _loading ? null : _load),
        ]),
        body,
      ]),
    );
  }
}
