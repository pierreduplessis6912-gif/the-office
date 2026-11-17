// What a person can do to a job from the Jobs room: mark it done, note a snag, close a snag, move its date, cancel it, tie an invoice, quotation or expense to it. Every one only PROPOSES (the engine holds it for
// approval and checks every rule when it is approved); the app turns what was chosen or typed into the engine's payload and shows the engine's own reason on a refusal.
import 'package:flutter/material.dart';

import '../slice_model.dart' show parseProposal, randFromMinor;
import 'assistant_model.dart';
import 'engine_api.dart';

enum JobAction { done, snag, closeSnag, move, cancel, tie }

String jobActionLabel(JobAction a) => switch (a) {
      JobAction.done => 'Mark done',
      JobAction.snag => 'Note a snag',
      JobAction.closeSnag => 'Close a snag',
      JobAction.move => 'Move the date',
      JobAction.cancel => 'Cancel the job',
      JobAction.tie => 'Tie money to it',
    };

/// Sends one proposal and says what happened. Returns the sentence to show.
Future<String> sendJobProposal(EngineApi api, String capability, Map<String, Object?> payload) async {
  try {
    final r = await api.propose(capability, payload, 'Added from the Jobs screen');
    final p = parseProposal(r.status, r.body);
    if (p.held) return 'Sent for approval.';
    return p.message ?? 'That could not be sent. Try again.';
  } catch (_) {
    return 'That could not be sent. Try again.';
  }
}

Future<String?> _ask(BuildContext context, String title, String label, {String? initial, String hint = ''}) {
  final c = TextEditingController(text: initial ?? '');
  return showDialog<String>(
    context: context,
    builder: (ctx) => AlertDialog(
      title: Text(title),
      content: TextField(key: const Key('job-action-text'), controller: c, autofocus: true, decoration: InputDecoration(labelText: label, hintText: hint)),
      actions: [
        TextButton(key: const Key('job-action-cancel'), onPressed: () => Navigator.of(ctx).pop(), child: const Text('Back')),
        FilledButton(key: const Key('job-action-ok'), onPressed: () => Navigator.of(ctx).pop(c.text.trim()), child: const Text('Send for approval')),
      ],
    ),
  );
}

Future<int?> _choose(BuildContext context, String title, List<MapEntry<int, String>> options) {
  return showDialog<int>(
    context: context,
    builder: (ctx) => SimpleDialog(
      title: Text(title),
      children: [
        if (options.isEmpty) const Padding(padding: EdgeInsets.all(16), child: Text('Nothing to choose from.', key: Key('job-action-none'))),
        for (final o in options) SimpleDialogOption(key: Key('job-action-pick-${o.key}'), onPressed: () => Navigator.of(ctx).pop(o.key), child: Text(o.value)),
      ],
    ),
  );
}

/// What is offered for tying: this customer's invoices and quotations, and any expense. Each is labelled so it can be told apart.
Future<List<MapEntry<int, String>>> tieOptions(EngineApi api, JobEntry job) async {
  final out = <MapEntry<int, String>>[];
  try {
    final r = await api.invoices();
    for (final i in parseInvoiceList(r.status, r.body)?.rows ?? <InvoiceEntry>[]) {
      if (i.customer == job.customer) out.add(MapEntry(i.id, 'Invoice${i.number == null ? '' : ' #${i.number}'} · ${randFromMinor(i.grossMinor)}'));
    }
  } catch (_) {}
  try {
    final r = await api.quotations();
    for (final q in parseQuoteList(r.status, r.body) ?? <AssistantQuote>[]) {
      if (q.customer == job.customer) out.add(MapEntry(q.id, 'Quotation${q.number == null ? '' : ' #${q.number}'} · ${randFromMinor(q.grossMinor)}'));
    }
  } catch (_) {}
  try {
    final r = await api.expenses();
    for (final e in parseExpenseList(r.status, r.body) ?? <AssistantExpense>[]) {
      out.add(MapEntry(e.id, 'Expense · ${e.supplier} · ${randFromMinor(e.grossMinor)}'));
    }
  } catch (_) {}
  return out;
}

/// Runs one action on a job and returns the sentence to show, or null when the person backed out.
Future<String?> runJobAction(BuildContext context, EngineApi api, JobEntry job, JobAction action) async {
  switch (action) {
    case JobAction.done:
      return sendJobProposal(api, 'job.complete', <String, Object?>{'jobId': job.id});
    case JobAction.snag:
      final note = await _ask(context, 'Note a snag', 'What is still to put right?');
      if (note == null) return null;
      if (note.isEmpty) return 'Say what the snag is.';
      return sendJobProposal(api, 'job.snag_raise', <String, Object?>{'jobId': job.id, 'note': note});
    case JobAction.closeSnag:
      if (job.openSnagList.isEmpty) return 'This job has no open snag.';
      final id = await _choose(context, 'Close which snag?', [for (final s in job.openSnagList) MapEntry(s.id, s.note)]);
      if (id == null) return null;
      return sendJobProposal(api, 'job.snag_close', <String, Object?>{'jobId': job.id, 'snagId': id});
    case JobAction.move:
      final date = await _ask(context, 'Move the date', 'New date (YYYY-MM-DD, empty for no date)', initial: job.scheduledOn);
      if (date == null) return null;
      if (date.isNotEmpty && !RegExp(r'^\d{4}-\d{2}-\d{2}$').hasMatch(date)) return 'The date must look like 2026-11-20, or be left empty.';
      return sendJobProposal(api, 'job.schedule', <String, Object?>{'jobId': job.id, 'scheduledOn': date.isEmpty ? null : date});
    case JobAction.cancel:
      final why = await _ask(context, 'Cancel the job', 'Why?');
      if (why == null) return null;
      if (why.isEmpty) return 'A job needs a reason to be cancelled.';
      return sendJobProposal(api, 'job.cancel', <String, Object?>{'jobId': job.id, 'reason': why});
    case JobAction.tie:
      final options = await tieOptions(api, job);
      if (!context.mounted) return null;
      final id = await _choose(context, 'Tie which one?', options);
      if (id == null) return null;
      return sendJobProposal(api, 'job.link', <String, Object?>{'jobId': job.id, 'documentId': id});
  }
}
