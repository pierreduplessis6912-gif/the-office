// What needs attention: the list the engine works out (GET /engine/attention), shown in the engine's own order with its own reason under each line. It only READS; nothing here changes anything.
import 'package:flutter/material.dart';

import 'assistant_model.dart';
import 'engine_api.dart';

class AttentionRoom extends StatefulWidget {
  final EngineApi api;
  const AttentionRoom({super.key, required this.api});

  @override
  State<AttentionRoom> createState() => _AttentionRoomState();
}

class _AttentionRoomState extends State<AttentionRoom> {
  List<AttentionEntry> _rows = <AttentionEntry>[];
  bool _loading = true;
  bool _failed = false;
  bool _truncated = false;

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
    ({List<AttentionEntry> items, bool truncated, int count})? parsed;
    try {
      final response = await widget.api.attention();
      parsed = parseAttention(response.status, response.body);
    } catch (_) {
      parsed = null;
    }
    if (!mounted) return;
    setState(() {
      _rows = parsed?.items ?? <AttentionEntry>[];
      _truncated = parsed?.truncated ?? false;
      _failed = parsed == null;
      _loading = false;
    });
  }

  Color _colour(String kind) => switch (kind) {
        'bill_overdue' || 'invoice_late' || 'job_overdue' || 'job_snag' => const Color(0xFFB3261E),
        _ => const Color(0xFF8A8A90),
      };

  @override
  Widget build(BuildContext context) {
    if (_loading) return const Center(child: CircularProgressIndicator(key: Key('attention-loading')));
    if (_failed) {
      return Center(child: Column(mainAxisSize: MainAxisSize.min, children: [
        const Text('I could not read what needs attention.', key: Key('attention-failed')),
        TextButton(key: const Key('attention-retry'), onPressed: _load, child: const Text('Try again')),
      ]));
    }
    if (_rows.isEmpty) return const Center(child: Text('Nothing needs your attention right now.', key: Key('attention-empty')));
    return RefreshIndicator(
      onRefresh: _load,
      child: ListView(padding: const EdgeInsets.all(12), children: [
        for (var i = 0; i < _rows.length; i++)
          Card(
            key: Key('attention-row-$i'),
            child: ListTile(
              leading: Icon(Icons.error_outline, color: _colour(_rows[i].kind)),
              title: Text(_rows[i].title, style: const TextStyle(fontWeight: FontWeight.w600)),
              subtitle: _rows[i].detail.isEmpty ? null : Text(_rows[i].detail),
            ),
          ),
        if (_truncated) const Padding(padding: EdgeInsets.all(8), child: Text('Showing the first 50.', key: Key('attention-truncated'), style: TextStyle(fontSize: 12, color: Color(0xFF8A8A90)))),
      ]),
    );
  }
}
