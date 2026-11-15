// The customers and suppliers room: every party the engine lists (GET /engine/parties) with its role and contact details. Tapping a CUSTOMER shows what they still owe, invoice by invoice, from the receivables read the
// first slice already uses (parseReceivables); a supplier's bills are in the bills room. It only READS: nothing here computes a figure or changes a party (that is a held proposal the person approves).
import 'package:flutter/material.dart';

import '../slice_model.dart';
import 'assistant_model.dart';
import 'engine_api.dart';

class PartiesRoom extends StatefulWidget {
  final EngineApi api;
  const PartiesRoom({super.key, required this.api});

  @override
  State<PartiesRoom> createState() => _PartiesRoomState();
}

class _PartiesRoomState extends State<PartiesRoom> {
  List<PartyEntry> _rows = <PartyEntry>[];
  bool _loading = true;
  bool _failed = false;

  PartyEntry? _open;
  bool _owedLoading = false;
  SliceRead? _owed;

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
    List<PartyEntry>? rows;
    try {
      final response = await widget.api.parties();
      rows = parsePartyList(response.status, response.body);
    } catch (_) {
      rows = null;
    }
    if (!mounted) return;
    setState(() {
      _rows = rows ?? <PartyEntry>[];
      _failed = rows == null;
      _loading = false;
    });
  }

  Future<void> _show(PartyEntry p) async {
    if (!p.isCustomer) return;
    setState(() {
      _open = p;
      _owed = null;
      _owedLoading = true;
    });
    SliceRead read;
    try {
      final response = await widget.api.receivables('${p.id}');
      read = parseReceivables(response.status, response.body);
    } catch (_) {
      read = const SliceRead.unusable();
    }
    if (!mounted) return;
    setState(() {
      _owed = read;
      _owedLoading = false;
    });
  }

  static const _grey = TextStyle(fontSize: 12, color: Color(0xFF8A8A90));

  Widget _row(PartyEntry p) {
    final role = p.isCustomer ? 'Customer' : (p.roles.contains('supplier') ? 'Supplier' : '');
    final contact = <String>[if (p.email.isNotEmpty) p.email, if (p.phone.isNotEmpty) p.phone].join(' · ');
    return Card(
      key: Key('party-row-${p.id}'),
      child: InkWell(
        onTap: () => _show(p),
        child: Padding(
          padding: const EdgeInsets.all(12),
          child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text(p.name, style: const TextStyle(fontWeight: FontWeight.w600)),
                if (contact.isNotEmpty) Text(contact, style: _grey),
              ]),
            ),
            if (role.isNotEmpty) Text(role, style: _grey),
          ]),
        ),
      ),
    );
  }

  Widget _detail(PartyEntry p) {
    final read = _owed;
    Widget body;
    if (_owedLoading || read == null) {
      body = const Padding(padding: EdgeInsets.all(12), child: Text('Reading…', style: TextStyle(color: Color(0xFF8A8A90))));
    } else if (read.kind != SliceReadKind.answer || read.answer == null) {
      body = Padding(padding: const EdgeInsets.all(12), child: Text(read.message ?? 'What this customer owes could not be read. Try again.', key: const Key('party-owed-error')));
    } else {
      final a = read.answer!;
      body = Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Padding(padding: const EdgeInsets.symmetric(vertical: 8), child: Text('${a.totalText} owed', style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w600))),
        if (a.lines.isEmpty) const Text('Nothing is owed.', key: Key('party-owed-none')),
        for (final l in a.lines)
          Card(
            child: Padding(
              padding: const EdgeInsets.all(12),
              child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Expanded(
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Text(l.number == null ? _kindWords(l.kind) : '${_kindWords(l.kind)} #${l.number}', style: const TextStyle(fontWeight: FontWeight.w600)),
                    Text('Issued ${l.issuedOn}', style: _grey),
                  ]),
                ),
                Column(crossAxisAlignment: CrossAxisAlignment.end, children: [
                  Text('${randFromMinor(l.outstandingMinor, currency: a.currency)} owed'),
                  Text('of ${randFromMinor(l.grossMinor, currency: a.currency)}', style: _grey),
                ]),
              ]),
            ),
          ),
      ]);
    }
    return SafeArea(
      child: ListView(padding: const EdgeInsets.all(12), children: [
        Align(alignment: Alignment.centerLeft, child: TextButton.icon(key: const Key('party-back'), onPressed: () => setState(() => _open = null), icon: const Icon(Icons.arrow_back), label: const Text('Customers and suppliers'))),
        Text(p.name, style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w600)),
        body,
      ]),
    );
  }

  String _kindWords(String kind) {
    final k = kind.replaceAll('_', ' ');
    return k.isEmpty ? 'Document' : '${k[0].toUpperCase()}${k.substring(1)}';
  }

  @override
  Widget build(BuildContext context) {
    final open = _open;
    if (open != null) return _detail(open);
    Widget body;
    if (_loading) {
      body = const Padding(padding: EdgeInsets.all(12), child: Text('Reading…', style: TextStyle(color: Color(0xFF8A8A90))));
    } else if (_failed) {
      body = const Padding(padding: EdgeInsets.all(12), child: Text('The customers and suppliers could not be read. Try again.', key: Key('parties-error')));
    } else if (_rows.isEmpty) {
      body = const Padding(padding: EdgeInsets.all(12), child: Text('No customers or suppliers yet.', key: Key('parties-empty')));
    } else {
      body = Column(children: [for (final p in _rows) _row(p)]);
    }
    return SafeArea(
      child: ListView(padding: const EdgeInsets.all(12), children: [
        Row(children: [
          const Expanded(child: Text('Customers and suppliers', style: TextStyle(fontSize: 18, fontWeight: FontWeight.w600))),
          IconButton(key: const Key('parties-refresh'), tooltip: 'Check again', icon: const Icon(Icons.refresh), onPressed: _loading ? null : _load),
        ]),
        body,
      ]),
    );
  }
}
