// The stock room: what the business has of each item, as the engine reports it (GET /engine/stock): how much there is, how much is already promised, whether it is below its reorder level, and the value when
// the person may see money. It only READS; stock is changed through held proposals the person approves. Nothing here computes a quantity or a figure.
import 'package:flutter/material.dart';

import '../slice_model.dart' show randFromMinor;
import 'assistant_model.dart';
import 'engine_api.dart';

class StockRoom extends StatefulWidget {
  final EngineApi api;
  const StockRoom({super.key, required this.api});

  @override
  State<StockRoom> createState() => _StockRoomState();
}

class _StockRoomState extends State<StockRoom> {
  List<AssistantStockRow> _rows = <AssistantStockRow>[];
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
    List<AssistantStockRow>? rows;
    try {
      final response = await widget.api.stock();
      rows = parseStockList(response.status, response.body);
    } catch (_) {
      rows = null;
    }
    if (!mounted) return;
    setState(() {
      _rows = rows ?? <AssistantStockRow>[];
      _failed = rows == null;
      _loading = false;
    });
  }

  Widget _row(AssistantStockRow r) {
    const grey = TextStyle(fontSize: 12, color: Color(0xFF8A8A90));
    return Card(
      key: Key('stock-row-${r.id}'),
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(r.name, style: const TextStyle(fontWeight: FontWeight.w600)),
              if (r.reservedMilli > 0) Text('${quantityFromMilli(r.reservedMilli)} promised', style: grey),
              if (r.belowReorder) const Text('Below reorder level', style: TextStyle(fontSize: 12, color: Color(0xFFB3261E))),
            ]),
          ),
          Column(crossAxisAlignment: CrossAxisAlignment.end, children: [
            Text('${quantityFromMilli(r.quantityMilli)} ${r.unit}'.trim()),
            if (r.valueMinor != null) Text('Value ${randFromMinor(r.valueMinor!)}', style: grey),
          ]),
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
      body = const Padding(padding: EdgeInsets.all(12), child: Text('The stock could not be read. Try again.', key: Key('stock-error')));
    } else if (_rows.isEmpty) {
      body = const Padding(padding: EdgeInsets.all(12), child: Text('No stock items yet.', key: Key('stock-empty')));
    } else {
      body = Column(children: [for (final r in _rows) _row(r)]);
    }
    return SafeArea(
      child: ListView(padding: const EdgeInsets.all(12), children: [
        Row(children: [
          const Expanded(child: Text('Stock', style: TextStyle(fontSize: 18, fontWeight: FontWeight.w600))),
          IconButton(key: const Key('stock-refresh'), tooltip: 'Check again', icon: const Icon(Icons.refresh), onPressed: _loading ? null : _load),
        ]),
        body,
      ]),
    );
  }
}
