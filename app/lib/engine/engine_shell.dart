// The engine shell, first step of the visible slice (docs/decisions/first-slice.md, section B): the persistent orb, a typed question, and the answer card. A quiet black screen (DESIGN_CONSTITUTION_V2.md): one orb, nothing else until the
// person asks, and an answer that arrives as a card, not a chat bubble. THE SHELL COMPUTES NOTHING: every figure is formatted from the engine's whole-number minor units (slice_model.dart), and what a member may see is the engine's decision.
// A refusal is a boundary, never red; a business without the capability is told so honestly. Drill-down (criterion 3): a tap on an invoice line opens its record as a ROOM that replaces the answer (not a popup) and the orb stays; from a room the person can open what it names (the customer, a payment, an invoice) and go back one step at a time, and "back to the conversation" returns to the answer. The approval card and the trace sheet come in later steps. This file is not wired into main.dart.
import 'package:flutter/material.dart';
import '../refusal_view.dart';
import '../slice_model.dart';
import 'engine_api.dart';
import 'engine_orb.dart';
import 'scripted_interpreter.dart';

const Color _void = Color(0xFF0A0A0B);
const Color _textPrimary = Color(0xFFF5F5F5);
const Color _textSecondary = Color(0xFF8A8A8F);
const Color _textTertiary = Color(0xFF5A5A5F);
const Color _ember = Color(0xFFC4432B);

class EngineShell extends StatefulWidget {
  final EngineApi api;
  const EngineShell({super.key, required this.api});

  @override
  State<EngineShell> createState() => _EngineShellState();
}

class _EngineShellState extends State<EngineShell> {
  SliceFlow _flow = const SliceFlow.resting();
  final TextEditingController _controller = TextEditingController();
  String? _note;
  String? _recordNote;
  final List<SliceRecord> _trail = <SliceRecord>[];

  Future<void> _submit() async {
    final text = _controller.text.trim();
    if (text.isEmpty) return;
    _controller.clear();
    final name = scriptedCustomerName(text);
    if (name == null) {
      setState(() {
        _flow = const SliceFlow.resting();
        _note = 'In this first version I can only answer what a customer owes. Try: "What does Mokoena owe me?"';
      });
      return;
    }
    setState(() {
      _note = null;
      _recordNote = null;
      _trail.clear();
      _flow = const SliceFlow.resting().asked();
    });
    SliceRead read;
    try {
      final response = await widget.api.receivables(name);
      read = parseReceivables(response.status, response.body);
    } catch (_) {
      read = const SliceRead.unusable();
    }
    if (!mounted) return;
    setState(() => _flow = _flow.received(read));
  }

  /// Opens a record named by the answer or by another record. A record the engine will not show (hidden or missing: it answers the same either way) leaves the person where they are, with a plain line.
  Future<void> _open(SliceRef ref) async {
    SliceRecord? record;
    try {
      final response = await widget.api.record(ref.kind, ref.id);
      record = parseRecord(response.status, response.body);
    } catch (_) {
      record = null;
    }
    if (!mounted) return;
    final opened = record;
    setState(() {
      if (opened == null) {
        _recordNote = 'That record is not available.';
        return;
      }
      _recordNote = null;
      final current = _flow.record;
      if (current != null) _trail.add(current);
      _flow = _flow.opened(opened);
    });
  }

  /// Back one step: to the record the person came from, or, from the first record, to the conversation.
  void _back() {
    setState(() {
      _recordNote = null;
      if (_trail.isNotEmpty) {
        _flow = _flow.opened(_trail.removeLast());
      } else {
        _flow = _flow.backToConversation();
      }
    });
  }

  void _toConversation() {
    setState(() {
      _recordNote = null;
      _trail.clear();
      _flow = _flow.backToConversation();
    });
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  Widget _content() {
    final answer = _flow.answer;
    switch (_flow.step) {
      case SliceStep.answered:
        if (answer == null) return const SizedBox.shrink();
        return Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            _AnswerCard(answer: answer, onOpen: _open),
            if (_recordNote != null) Padding(padding: const EdgeInsets.only(top: 12), child: Text(_recordNote!, style: const TextStyle(color: _textSecondary, fontSize: 13))),
          ],
        );
      case SliceStep.record:
        final record = _flow.record;
        if (record == null) return const SizedBox.shrink();
        return _RecordRoom(
          record: record,
          currency: answer?.currency,
          note: _recordNote,
          onOpen: _open,
          onBack: _back,
          onConversation: _toConversation,
          canStepBack: _trail.isNotEmpty,
        );
      case SliceStep.ambiguous:
        return _Quiet(
          title: 'WHICH ONE?',
          lines: [for (final c in _flow.candidates) '${c.name} (customer ${c.id})'],
        );
      case SliceStep.refused:
        return _Boundary(heading: refusalHeading(const [], whole: true), hint: refusalHint(whole: true));
      case SliceStep.unavailable:
        return _Quiet(title: 'NOT AVAILABLE', lines: [_flow.message ?? 'This is not available for this business.']);
      case SliceStep.problem:
        return _Quiet(title: null, lines: [_flow.message ?? 'Something went wrong.']);
      case SliceStep.resting:
        return _note == null ? const SizedBox.shrink() : _Quiet(title: null, lines: [_note!]);
      default:
        return const SizedBox.shrink();
    }
  }

  @override
  Widget build(BuildContext context) {
    final busy = _flow.orbPhase == 'thinking' || _flow.orbPhase == 'executing';
    return Scaffold(
      backgroundColor: _void,
      body: SafeArea(
        child: Column(
          children: [
            const SizedBox(height: 24),
            Center(child: EngineOrb(active: busy)),
            Expanded(
              child: SingleChildScrollView(
                padding: const EdgeInsets.fromLTRB(24, 24, 24, 8),
                child: _content(),
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
              child: Row(
                children: [
                  Expanded(
                    child: TextField(
                      key: const Key('ask-field'),
                      controller: _controller,
                      style: const TextStyle(color: _textPrimary),
                      cursorColor: _ember,
                      textInputAction: TextInputAction.send,
                      onSubmitted: (_) => _submit(),
                      decoration: const InputDecoration(
                        hintText: 'Ask',
                        hintStyle: TextStyle(color: _textTertiary),
                        enabledBorder: UnderlineInputBorder(borderSide: BorderSide(color: _textTertiary)),
                        focusedBorder: UnderlineInputBorder(borderSide: BorderSide(color: _ember)),
                      ),
                    ),
                  ),
                  IconButton(
                    key: const Key('ask-send'),
                    tooltip: 'Ask',
                    icon: const Icon(Icons.arrow_upward, color: _textSecondary),
                    onPressed: _submit,
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _AnswerCard extends StatelessWidget {
  final SliceAnswer answer;
  final void Function(SliceRef) onOpen;
  const _AnswerCard({required this.answer, required this.onOpen});

  String _title(SliceLine line) {
    final kind = line.kind.isEmpty ? 'Document' : '${line.kind[0].toUpperCase()}${line.kind.substring(1)}';
    return line.number == null ? kind : '$kind #${line.number}';
  }

  @override
  Widget build(BuildContext context) {
    final currency = answer.currency;
    return Semantics(
      container: true,
      liveRegion: true,
      label: '${answer.partyName} owes ${answer.totalText}',
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(answer.partyName, style: const TextStyle(color: _textSecondary, fontSize: 14, letterSpacing: 0.6)),
          const SizedBox(height: 4),
          Text(answer.totalText, key: const Key('answer-total'), style: const TextStyle(color: _textPrimary, fontSize: 34, fontWeight: FontWeight.w600)),
          const Text('outstanding', style: TextStyle(color: _textTertiary, fontSize: 12)),
          const SizedBox(height: 20),
          for (final line in answer.lines)
            Semantics(
              button: true,
              label: 'Open ${_title(line)}',
              excludeSemantics: true,
              child: InkWell(
                key: Key('open-${line.ref.kind}-${line.ref.id}'),
                onTap: () => onOpen(line.ref),
                child: Padding(
                  padding: const EdgeInsets.only(bottom: 14),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(_title(line), style: const TextStyle(color: _textPrimary, fontSize: 15)),
                      Text(
                        'issued ${line.issuedOn} · ${randFromMinor(line.grossMinor, currency: currency)} · paid ${randFromMinor(line.allocatedMinor, currency: currency)}',
                        style: const TextStyle(color: _textSecondary, fontSize: 12),
                      ),
                      Text('${randFromMinor(line.outstandingMinor, currency: currency)} outstanding', style: const TextStyle(color: _textSecondary, fontSize: 12)),
                    ],
                  ),
                ),
              ),
            ),
          const SizedBox(height: 8),
          Text('Source: ${answer.derivedBy}, account version ${answer.version}', style: const TextStyle(color: _textTertiary, fontSize: 11)),
        ],
      ),
    );
  }
}

int? _whole(Object? v) => v is int ? v : null;

/// A record opened from the answer, shown as a room: what it is, its figures with where they came from, what it is made of, what it connects to, and what happened to it. Formatting only: every number is the engine's.
class _RecordRoom extends StatelessWidget {
  final SliceRecord record;
  final String? currency;
  final String? note;
  final void Function(SliceRef) onOpen;
  final VoidCallback onBack;
  final VoidCallback onConversation;
  final bool canStepBack;
  const _RecordRoom({required this.record, required this.currency, required this.note, required this.onOpen, required this.onBack, required this.onConversation, required this.canStepBack});

  static const Map<String, String> _sections = <String, String>{
    'lines': 'LINES',
    'allocations': 'PAYMENTS APPLIED',
    'documents': 'DOCUMENTS',
    'payments': 'PAYMENTS',
  };

  String _money(Object? v) {
    final minor = _whole(v);
    return minor == null ? '' : randFromMinor(minor, currency: currency);
  }

  String _quantity(Object? v) {
    final milli = _whole(v);
    if (milli == null) return '';
    if (milli % 1000 == 0) return '${milli ~/ 1000}';
    return (milli / 1000).toStringAsFixed(3);
  }

  String _kindWord(Object? kind) {
    final k = kind is String && kind.isNotEmpty ? kind : 'document';
    return '${k[0].toUpperCase()}${k.substring(1)}';
  }

  /// One line for a row of a collection, in the engine's own words and figures.
  String _rowText(String collection, Map<String, Object?> row) {
    switch (collection) {
      case 'lines':
        return '${row['description'] ?? ''} · ${_quantity(row['quantityMilli'])} ${row['unit'] ?? ''} at ${_money(row['unitPriceMinor'])}';
      case 'allocations':
        final stands = row['effective'] == true;
        final who = row['movementId'] != null ? 'Payment ${row['movementId']}' : 'Invoice ${row['documentId']}';
        return '$who · ${_money(row['amountMinor'])} · ${stands ? 'stands' : 'reversed'}';
      case 'documents':
        return '${_kindWord(row['kind'])} #${row['number'] ?? row['id']} · ${row['issuedOn'] ?? ''} · ${_money(row['outstandingMinor'])} outstanding';
      case 'payments':
        return 'Payment ${row['id']} · ${_money(row['amountMinor'])}${row['effective'] == false ? ' · reversed' : ''}';
      default:
        return '${row['id'] ?? ''}';
    }
  }

  /// The record a row opens, when it names one.
  SliceRef? _rowRef(String collection, Map<String, Object?> row) {
    switch (collection) {
      case 'allocations':
        final m = _whole(row['movementId']);
        if (m != null) return SliceRef(kind: 'movement', id: m);
        final d = _whole(row['documentId']);
        return d == null ? null : SliceRef(kind: 'document', id: d);
      case 'documents':
        final id = _whole(row['id']);
        return id == null ? null : SliceRef(kind: 'document', id: id);
      case 'payments':
        final id = _whole(row['id']);
        return id == null ? null : SliceRef(kind: 'movement', id: id);
      default:
        return null;
    }
  }

  Widget _heading(String text) => Padding(
        padding: const EdgeInsets.only(top: 22, bottom: 8),
        child: Text(text, style: const TextStyle(color: _textTertiary, fontSize: 11, letterSpacing: 1.4)),
      );

  Widget _row(String text, {SliceRef? opens, Key? key}) {
    final body = Padding(padding: const EdgeInsets.symmetric(vertical: 6), child: Text(text, style: TextStyle(color: opens == null ? _textSecondary : _textPrimary, fontSize: 14)));
    if (opens == null) return body;
    return Semantics(button: true, label: 'Open $text', excludeSemantics: true, child: InkWell(key: key, onTap: () => onOpen(opens), child: body));
  }

  @override
  Widget build(BuildContext context) {
    return Semantics(
      container: true,
      liveRegion: true,
      label: record.title,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              if (canStepBack)
                TextButton(key: const Key('room-back'), onPressed: onBack, child: const Text('Back', style: TextStyle(color: _textSecondary))),
              TextButton(key: const Key('room-conversation'), onPressed: onConversation, child: const Text('Back to the conversation', style: TextStyle(color: _textSecondary))),
            ],
          ),
          const SizedBox(height: 4),
          Text(record.title, key: const Key('room-title'), style: const TextStyle(color: _textPrimary, fontSize: 26, fontWeight: FontWeight.w600)),
          const SizedBox(height: 14),
          for (final f in record.fields)
            Padding(
              padding: const EdgeInsets.only(bottom: 8),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text('${f.label}: ${f.display}', style: const TextStyle(color: _textPrimary, fontSize: 14)),
                  if (f.derivedBy != null) Text('derived by ${f.derivedBy}', style: const TextStyle(color: _textTertiary, fontSize: 11)),
                ],
              ),
            ),
          for (final entry in record.collections.entries)
            if (entry.value.isNotEmpty) ...[
              _heading(_sections[entry.key] ?? entry.key.toUpperCase()),
              for (final row in entry.value) _row(_rowText(entry.key, row), opens: _rowRef(entry.key, row)),
            ],
          if (record.relations.isNotEmpty) ...[
            _heading('CONNECTED'),
            for (final r in record.relations) _row('${r.role}: ${r.label}', opens: r.ref),
          ],
          if (record.history.isNotEmpty) ...[
            _heading('HISTORY'),
            for (final h in record.history) _row('${h.type} · ${h.at.length >= 10 ? h.at.substring(0, 10) : h.at}${h.reason == null ? '' : ' · ${h.reason}'}'),
          ],
          if (note != null) Padding(padding: const EdgeInsets.only(top: 16), child: Text(note!, style: const TextStyle(color: _textSecondary, fontSize: 13))),
        ],
      ),
    );
  }
}

/// A refusal is a boundary, not an error: a dimmed hollow ring, never red.
class _Boundary extends StatelessWidget {
  final String heading;
  final String? hint;
  const _Boundary({required this.heading, required this.hint});

  @override
  Widget build(BuildContext context) {
    return Semantics(
      container: true,
      liveRegion: true,
      label: hint == null ? heading : '$heading. $hint',
      child: Column(
        children: [
          Container(
            width: 36,
            height: 36,
            decoration: BoxDecoration(shape: BoxShape.circle, border: Border.all(color: _textTertiary, width: 1.5)),
          ),
          const SizedBox(height: 14),
          Text(heading, textAlign: TextAlign.center, style: const TextStyle(color: _textSecondary, fontSize: 12, letterSpacing: 1.2)),
          if (hint != null) ...[
            const SizedBox(height: 6),
            Text(hint!, textAlign: TextAlign.center, style: const TextStyle(color: _textTertiary, fontSize: 12)),
          ],
        ],
      ),
    );
  }
}

class _Quiet extends StatelessWidget {
  final String? title;
  final List<String> lines;
  const _Quiet({required this.title, required this.lines});

  @override
  Widget build(BuildContext context) {
    return Semantics(
      container: true,
      liveRegion: true,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (title != null) Padding(padding: const EdgeInsets.only(bottom: 8), child: Text(title!, style: const TextStyle(color: _textSecondary, fontSize: 12, letterSpacing: 1.2))),
          for (final l in lines) Padding(padding: const EdgeInsets.only(bottom: 6), child: Text(l, style: const TextStyle(color: _textPrimary, fontSize: 15))),
        ],
      ),
    );
  }
}
