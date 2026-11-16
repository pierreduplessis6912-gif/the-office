// The quotations room: the quotations that are not superseded, as the engine lists them (GET /engine/quotations): customer, number, issue date, valid-until date, status (open or accepted) and the total. It only
// READS; a quotation is made, accepted or changed through a held proposal the person approves. Nothing here computes a figure.
import 'package:flutter/material.dart';

import '../slice_model.dart' show randFromMinor;
import 'assistant_model.dart';
import 'engine_api.dart';
import 'quotation_form.dart';

class QuotesRoom extends StatefulWidget {
  final EngineApi api;
  const QuotesRoom({super.key, required this.api});

  @override
  State<QuotesRoom> createState() => _QuotesRoomState();
}

class _QuotesRoomState extends State<QuotesRoom> {
  List<AssistantQuote> _rows = <AssistantQuote>[];
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
    List<AssistantQuote>? rows;
    try {
      final response = await widget.api.quotations();
      rows = parseQuoteList(response.status, response.body);
    } catch (_) {
      rows = null;
    }
    if (!mounted) return;
    setState(() {
      _rows = rows ?? <AssistantQuote>[];
      _failed = rows == null;
      _loading = false;
    });
  }

  String _statusWords(String status) {
    if (status == 'open') return 'Open';
    if (status == 'accepted') return 'Accepted';
    return status;
  }

  Widget _row(AssistantQuote q) {
    const grey = TextStyle(fontSize: 12, color: Color(0xFF8A8A90));
    final title = q.number == null ? q.customer : '${q.customer} · #${q.number}';
    return Card(
      key: Key('quote-row-${q.id}'),
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(title, style: const TextStyle(fontWeight: FontWeight.w600)),
              if (q.issuedOn.isNotEmpty) Text('Issued ${q.issuedOn}', style: grey),
              if (q.validUntil.isNotEmpty) Text('Valid until ${q.validUntil}', style: grey),
            ]),
          ),
          Column(crossAxisAlignment: CrossAxisAlignment.end, children: [
            Text(randFromMinor(q.grossMinor)),
            if (q.status.isNotEmpty) Text(_statusWords(q.status), style: grey),
          ]),
        ]),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    if (_adding) return QuotationForm(key: const ValueKey<String>('quotation-form'), api: widget.api, onClose: () { setState(() => _adding = false); _load(); });
    Widget body;
    if (_loading) {
      body = const Padding(padding: EdgeInsets.all(12), child: Text('Reading…', style: TextStyle(color: Color(0xFF8A8A90))));
    } else if (_failed) {
      body = const Padding(padding: EdgeInsets.all(12), child: Text('The quotations could not be read. Try again.', key: Key('quotes-error')));
    } else if (_rows.isEmpty) {
      body = const Padding(padding: EdgeInsets.all(12), child: Text('No quotations yet.', key: Key('quotes-empty')));
    } else {
      body = Column(children: [for (final q in _rows) _row(q)]);
    }
    return SafeArea(
      child: ListView(padding: const EdgeInsets.all(12), children: [
        Row(children: [
          const Expanded(child: Text('Quotations', style: TextStyle(fontSize: 18, fontWeight: FontWeight.w600))),
          IconButton(key: const Key('quotes-add'), tooltip: 'Make a quotation', icon: const Icon(Icons.add), onPressed: () => setState(() => _adding = true)),
          IconButton(key: const Key('quotes-refresh'), tooltip: 'Check again', icon: const Icon(Icons.refresh), onPressed: _loading ? null : _load),
        ]),
        body,
      ]),
    );
  }
}
