// The jobs room: the open jobs as the engine lists them (GET /engine/jobs), grouped for reading: overdue, this week, later, and the ones with no date yet. It only READS; a job is made, moved, given to
// someone or cancelled through a held proposal the person approves. "Overdue" is the engine's own flag; the groups are only where a row is shown, nothing here changes a date.
import 'package:flutter/material.dart';

import '../slice_model.dart' show randFromMinor;
import 'assistant_model.dart';
import 'engine_api.dart';
import 'job_form.dart';

class JobsRoom extends StatefulWidget {
  final EngineApi api;
  final DateTime Function()? clock;
  const JobsRoom({super.key, required this.api, this.clock});

  @override
  State<JobsRoom> createState() => _JobsRoomState();
}

class _JobsRoomState extends State<JobsRoom> {
  List<JobEntry> _rows = <JobEntry>[];
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
    List<JobEntry>? rows;
    try {
      final response = await widget.api.jobs();
      rows = parseJobList(response.status, response.body);
    } catch (_) {
      rows = null;
    }
    if (!mounted) return;
    setState(() {
      _rows = rows ?? <JobEntry>[];
      _failed = rows == null;
      _loading = false;
    });
  }

  String _day(DateTime d) {
    String two(int n) => n.toString().padLeft(2, '0');
    return '${d.year.toString().padLeft(4, '0')}-${two(d.month)}-${two(d.day)}';
  }

  Widget _row(JobEntry j) {
    const grey = TextStyle(fontSize: 12, color: Color(0xFF8A8A90));
    return Card(
      key: Key('job-row-${j.id}'),
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text('${j.customer} · ${j.description}', style: const TextStyle(fontWeight: FontWeight.w600)),
              if (j.site.isNotEmpty) Text(j.site, style: grey),
              if (j.assignee.isNotEmpty) Text('With ${j.assignee}', style: grey),
              if (j.reference.isNotEmpty) Text('Ref ${j.reference}', style: grey),
              if (j.linked > 0) Text('Quoted ${randFromMinor(j.quotedMinor)} · Invoiced ${randFromMinor(j.invoicedMinor)} · Paid ${randFromMinor(j.paidMinor)} · Spent ${randFromMinor(j.spentMinor)} · Left over ${randFromMinor(j.leftOverMinor)}', key: Key('job-money-${j.id}'), style: grey),
            ]),
          ),
          Column(crossAxisAlignment: CrossAxisAlignment.end, children: [
            Text(j.scheduledOn.isEmpty ? 'No date yet' : j.scheduledOn, style: j.overdue ? const TextStyle(color: Color(0xFFB3261E), fontWeight: FontWeight.w600) : null),
            if (j.overdue) const Text('Overdue', style: TextStyle(fontSize: 12, color: Color(0xFFB3261E))),
          ]),
        ]),
      ),
    );
  }

  List<Widget> _group(String key, String title, List<JobEntry> rows) {
    if (rows.isEmpty) return <Widget>[];
    return <Widget>[
      Padding(padding: const EdgeInsets.only(top: 12, bottom: 4), child: Text(title, key: Key('jobs-group-$key'), style: const TextStyle(fontWeight: FontWeight.w600, color: Color(0xFF8A8A90)))),
      for (final j in rows) _row(j),
    ];
  }

  @override
  Widget build(BuildContext context) {
    if (_adding) return JobForm(key: const ValueKey<String>('job-form'), api: widget.api, onClose: () { setState(() => _adding = false); _load(); }, clock: widget.clock);
    final today = (widget.clock ?? DateTime.now)();
    final from = _day(today), to = _day(today.add(const Duration(days: 6)));
    final overdue = _rows.where((j) => j.overdue).toList();
    final week = _rows.where((j) => !j.overdue && j.scheduledOn.isNotEmpty && j.scheduledOn.compareTo(from) >= 0 && j.scheduledOn.compareTo(to) <= 0).toList();
    final later = _rows.where((j) => !j.overdue && j.scheduledOn.isNotEmpty && j.scheduledOn.compareTo(to) > 0).toList();
    final undated = _rows.where((j) => j.scheduledOn.isEmpty).toList();
    Widget body;
    if (_loading) {
      body = const Padding(padding: EdgeInsets.all(12), child: Text('Reading…', style: TextStyle(color: Color(0xFF8A8A90))));
    } else if (_failed) {
      body = const Padding(padding: EdgeInsets.all(12), child: Text('The jobs could not be read. Try again.', key: Key('jobs-error')));
    } else if (_rows.isEmpty) {
      body = const Padding(padding: EdgeInsets.all(12), child: Text('No open jobs.', key: Key('jobs-empty')));
    } else {
      body = Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        ..._group('overdue', 'Overdue', overdue),
        ..._group('week', 'This week', week),
        ..._group('later', 'Later', later),
        ..._group('undated', 'No date yet', undated),
      ]);
    }
    return SafeArea(
      child: ListView(padding: const EdgeInsets.all(12), children: [
        Row(children: [
          const Expanded(child: Text('Jobs', style: TextStyle(fontSize: 18, fontWeight: FontWeight.w600))),
          IconButton(key: const Key('jobs-add'), tooltip: 'Make a job', icon: const Icon(Icons.add), onPressed: () => setState(() => _adding = true)),
          IconButton(key: const Key('jobs-refresh'), tooltip: 'Check again', icon: const Icon(Icons.refresh), onPressed: _loading ? null : _load),
        ]),
        body,
      ]),
    );
  }
}
