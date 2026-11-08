// The engine shell, first step of the visible slice (docs/decisions/first-slice.md, section B): the persistent orb, a typed question, and the answer card. A quiet black screen (DESIGN_CONSTITUTION_V2.md): one orb, nothing else until the
// person asks, and an answer that arrives as a card, not a chat bubble. THE SHELL COMPUTES NOTHING: every figure is formatted from the engine's whole-number minor units (slice_model.dart), and what a member may see is the engine's decision.
// A refusal is a boundary, never red; a business without the capability is told so honestly. Drill-down (criterion 3): a tap on an invoice line opens its record as a ROOM that replaces the answer (not a popup) and the orb stays; from a room the person can open what it names (the customer, a payment, an invoice) and go back one step at a time, and "back to the conversation" returns to the answer. Approval (criterion 4): "Record R500 from Mokoena" (a payment the person says was made, understood by a scripted pattern, and only for the customer whose answer is on screen) is proposed to the engine, which HOLDS it; an approval view then shows what the approver is approving, read from the held payment and, for names, through permission-checked record reads (audit decision D2): the customer, the amount, the exact invoice allocation, what was said and the account version it was based on, with what the Office assumed marked. Nothing is recorded until the person approves; then the answer is read again. The trace sheet comes in a later step. This file is not wired into main.dart.
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

  /// Today, for the date a payment is proposed with. Injected so a test can fix it.
  final DateTime Function()? clock;

  /// A quiet line under the input, for a demo to say plainly what it is running on.
  final String? footnote;
  const EngineShell({super.key, required this.api, this.clock, this.footnote});

  @override
  State<EngineShell> createState() => _EngineShellState();
}

class _EngineShellState extends State<EngineShell> {
  SliceFlow _flow = const SliceFlow.resting();
  final TextEditingController _controller = TextEditingController();
  String? _note;
  String? _recordNote;
  final List<SliceRecord> _trail = <SliceRecord>[];
  _Approval? _approval;
  String? _approvalNote;
  bool _viewingApproval = false;
  String? _recorded;
  bool _working = false;

  Future<void> _submit() async {
    final text = _controller.text.trim();
    if (text.isEmpty) return;
    _controller.clear();
    final name = scriptedCustomerName(text);
    if (name == null) {
      final payment = scriptedPayment(text);
      if (payment != null) {
        await _propose(payment, text);
        return;
      }
      setState(() {
        _flow = const SliceFlow.resting();
        _approval = null;
        _recorded = null;
        _note = 'In this first version I can only answer what a customer owes, or take a payment you say was made. Try: "What does Mokoena owe me?"';
      });
      return;
    }
    setState(() {
      _note = null;
      _recordNote = null;
      _recorded = null;
      _approval = null;
      _viewingApproval = false;
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
    if (_flow.step != SliceStep.answered && _flow.step != SliceStep.record) return;
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


  String _today() {
    final d = (widget.clock ?? DateTime.now)();
    String two(int n) => n.toString().padLeft(2, '0');
    return '${d.year.toString().padLeft(4, '0')}-${two(d.month)}-${two(d.day)}';
  }

  Future<SliceRecord?> _read(String kind, int id) async {
    try {
      final response = await widget.api.record(kind, id);
      return parseRecord(response.status, response.body);
    } catch (_) {
      return null;
    }
  }

  /// "Record R500 from Mokoena": propose it, then show what the approver would be approving. Only for the customer whose answer is on screen, so the Office never guesses which customer is meant.
  Future<void> _propose(ScriptedPayment payment, String said) async {
    final answer = _flow.answer;
    final inAnswer = _flow.step == SliceStep.answered || _flow.step == SliceStep.record;
    if (answer == null || !inAnswer || answer.partyName.toLowerCase() != payment.customerName.toLowerCase()) {
      setState(() => _recordNote = 'Ask what ${payment.customerName} owes first, so I know which customer you mean.');
      if (_flow.step == SliceStep.resting) setState(() => _note = 'Ask what ${payment.customerName} owes first, so I know which customer you mean.');
      return;
    }
    setState(() {
      _recordNote = null;
      _working = true;
    });
    SliceProposal proposal;
    try {
      final response = await widget.api.proposePayment(<String, Object?>{
        'partyId': answer.partyId,
        'amountMinor': payment.amountMinor,
        'currency': answer.currency,
        'occurredOn': _today(),
        'allocate': 'oldest_first',
      }, said);
      proposal = parseProposal(response.status, response.body);
    } catch (_) {
      proposal = const SliceProposal(held: false, error: 'unusable');
    }
    SliceHeldPayment? held;
    if (proposal.held) {
      try {
        final response = await widget.api.pending();
        for (final h in parseHeldPayments(response.status, response.body)) {
          if (h.actionId == proposal.actionId) held = h;
        }
      } catch (_) {
        held = null;
      }
    }
    _Approval? approval;
    if (held != null) {
      final customer = await _read('party', held.partyId);
      final lines = <_ApprovalLine>[];
      for (final a in held.allocations) {
        final doc = await _read('document', a.documentId);
        lines.add(_ApprovalLine(documentId: a.documentId, title: doc?.title, amountMinor: a.amountMinor));
      }
      approval = _Approval(held: held, customerName: customer?.title, lines: lines);
    }
    if (!mounted) return;
    setState(() {
      _working = false;
      if (proposal.held && approval == null) {
        _flow = _flow.proposed(const SliceProposal(held: false, message: 'The payment was proposed, but I could not read what is waiting for approval, so nothing more was done.'));
        return;
      }
      _flow = _flow.proposed(proposal);
      if (_flow.step == SliceStep.held) {
        _approval = approval;
        _approvalNote = null;
        _viewingApproval = true;
      }
    });
  }

  /// The person approves. Only then does the engine record the payment; the answer is then read again so the figures are the engine's.
  Future<void> _approve() async {
    final approval = _approval;
    if (approval == null || _flow.step != SliceStep.held) return;
    setState(() => _flow = _flow.approving());
    SliceConfirm confirm;
    try {
      final response = await widget.api.confirm(approval.held.actionId);
      confirm = parseConfirm(response.status, response.body);
    } catch (_) {
      confirm = const SliceConfirm(ok: false, error: 'unusable');
    }
    final answer = _flow.answer;
    SliceRead? again;
    if (confirm.ok && answer != null) {
      try {
        final response = await widget.api.receivables(answer.partyName);
        again = parseReceivables(response.status, response.body);
      } catch (_) {
        again = const SliceRead.unusable();
      }
    }
    if (!mounted) return;
    setState(() {
      _flow = _flow.confirmed(confirm);
      _approval = null;
      _viewingApproval = false;
      if (confirm.ok) {
        _recorded = 'Recorded ${approval.held.amountText} from ${approval.customerName ?? answer?.partyName ?? 'the customer'}.${approval.held.unallocatedMinor > 0 ? ' ${approval.held.unallocatedText} of it is on the account, not applied to an invoice.' : ''}';
        _flow = const SliceFlow.resting().asked().received(again ?? const SliceRead.unusable());
      }
    });
  }

  /// The person declines the held payment. Only the engine's answer decides: if it refuses (the member may not decline), the payment still waits and the card says why.
  Future<void> _decline() async {
    final approval = _approval;
    if (approval == null || _flow.step != SliceStep.held) return;
    SliceReject result;
    try {
      final response = await widget.api.reject(approval.held.actionId);
      result = parseReject(response.status, response.body);
    } catch (_) {
      result = const SliceReject(ok: false, error: 'unusable');
    }
    if (!mounted) return;
    setState(() {
      if (!result.ok) {
        _approvalNote = result.message ?? 'The payment could not be declined, so it still waits.';
        return;
      }
      _flow = _flow.declined(result);
      _approvalNote = null;
      _approval = null;
      _viewingApproval = false;
      _recorded = 'Declined. ${approval.held.amountText} from ${approval.customerName ?? _flow.answer?.partyName ?? 'the customer'} was not recorded.';
    });
  }

  /// Back to the conversation from the approval view: the payment stays held, and the answer says so.
  void _leaveApproval() => setState(() => _viewingApproval = false);

  void _reviewApproval() => setState(() => _viewingApproval = true);

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
            if (_recorded != null) Padding(padding: const EdgeInsets.only(bottom: 16), child: Text(_recorded!, key: const Key('recorded'), style: const TextStyle(color: _textPrimary, fontSize: 14))),
            _AnswerCard(answer: answer, onOpen: _open),
            if (_recordNote != null) Padding(padding: const EdgeInsets.only(top: 12), child: Text(_recordNote!, style: const TextStyle(color: _textSecondary, fontSize: 13))),
          ],
        );
      case SliceStep.held:
      case SliceStep.approving:
        final approval = _approval;
        if (approval == null) return const SizedBox.shrink();
        if (_viewingApproval || _flow.step == SliceStep.approving) {
          return _ApprovalCard(approval: approval, currency: answer?.currency, busy: _flow.step == SliceStep.approving, note: _approvalNote, onApprove: _approve, onDecline: _decline, onBack: _leaveApproval);
        }
        return Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            if (answer != null) _AnswerCard(answer: answer, onOpen: _open),
            const SizedBox(height: 12),
            InkWell(
              key: const Key('review-waiting'),
              onTap: _reviewApproval,
              child: Padding(
                padding: const EdgeInsets.symmetric(vertical: 8),
                child: Text('A payment of ${approval.held.amountText} is waiting for your approval. Review it.', style: const TextStyle(color: _ember, fontSize: 13)),
              ),
            ),
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
    final busy = _working || _flow.orbPhase == 'thinking' || _flow.orbPhase == 'executing';
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
            if (widget.footnote != null)
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 0, 16, 10),
                child: Text(widget.footnote!, key: const Key('footnote'), textAlign: TextAlign.center, style: const TextStyle(color: _textTertiary, fontSize: 10)),
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

class _ApprovalLine {
  final int documentId;
  final String? title;
  final int amountMinor;
  const _ApprovalLine({required this.documentId, required this.title, required this.amountMinor});
}

/// What the approver is approving: the held payment, with the names read through record reads. A name that could not be read is shown as a number and marked, never guessed.
class _Approval {
  final SliceHeldPayment held;
  final String? customerName;
  final List<_ApprovalLine> lines;
  const _Approval({required this.held, required this.customerName, required this.lines});
}

class _ApprovalCard extends StatelessWidget {
  final _Approval approval;
  final String? currency;
  final bool busy;
  final String? note;
  final VoidCallback onApprove;
  final VoidCallback onDecline;
  final VoidCallback onBack;
  const _ApprovalCard({required this.approval, required this.currency, required this.busy, required this.note, required this.onApprove, required this.onDecline, required this.onBack});

  @override
  Widget build(BuildContext context) {
    final held = approval.held;
    final customer = approval.customerName ?? 'customer ${held.partyId} (name not available)';
    return Semantics(
      container: true,
      liveRegion: true,
      label: 'Awaiting your approval: record ${held.amountText} from $customer',
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Text('AWAITING YOUR APPROVAL', style: TextStyle(color: _ember, fontSize: 11, letterSpacing: 1.4)),
          const SizedBox(height: 8),
          const Text('Record a payment', key: Key('approval-title'), style: TextStyle(color: _textPrimary, fontSize: 26, fontWeight: FontWeight.w600)),
          const SizedBox(height: 14),
          Text('From: $customer', style: const TextStyle(color: _textPrimary, fontSize: 15)),
          const SizedBox(height: 6),
          Text('Amount: ${held.amountText}', style: const TextStyle(color: _textPrimary, fontSize: 15)),
          const SizedBox(height: 14),
          const Text('Applied to', style: TextStyle(color: _textTertiary, fontSize: 11, letterSpacing: 1.4)),
          const SizedBox(height: 4),
          for (final line in approval.lines)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 3),
              child: Text('${line.title ?? 'Document ${line.documentId} (name not available)'}: ${randFromMinor(line.amountMinor, currency: held.currency)}', style: const TextStyle(color: _textPrimary, fontSize: 14)),
            ),
          if (held.unallocatedMinor > 0)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 3),
              child: Text('Not applied to any invoice: ${held.unallocatedText}. It stays on the account as unallocated.', key: const Key('approval-unallocated'), style: const TextStyle(color: _ember, fontSize: 14)),
            ),
          const SizedBox(height: 10),
          const Text('Applied oldest first: the Office chose this, you did not say.', style: TextStyle(color: _textSecondary, fontSize: 12)),
          Text('Dated ${held.occurredOn}: today, assumed.', style: const TextStyle(color: _textSecondary, fontSize: 12)),
          if (held.transcript.isNotEmpty) Text('You said: "${held.transcript}"', style: const TextStyle(color: _textSecondary, fontSize: 12)),
          if (held.partyVersion != null) Text('Based on account version ${held.partyVersion}.', style: const TextStyle(color: _textTertiary, fontSize: 11)),
          const SizedBox(height: 10),
          const Text('Nothing is recorded until you approve.', style: TextStyle(color: _textSecondary, fontSize: 12)),
          if (note != null) Padding(padding: const EdgeInsets.only(top: 10), child: Text(note!, key: const Key('approval-note'), style: const TextStyle(color: _ember, fontSize: 12))),
          const SizedBox(height: 18),
          Wrap(
            spacing: 8,
            crossAxisAlignment: WrapCrossAlignment.center,
            children: [
              ElevatedButton(
                key: const Key('approve'),
                onPressed: busy ? null : onApprove,
                style: ElevatedButton.styleFrom(backgroundColor: _ember, foregroundColor: _textPrimary),
                child: const Text('Approve'),
              ),
              TextButton(key: const Key('decline'), onPressed: busy ? null : onDecline, child: const Text('Decline', style: TextStyle(color: _textSecondary))),
              TextButton(key: const Key('approval-conversation'), onPressed: busy ? null : onBack, child: const Text('Back to the conversation', style: TextStyle(color: _textSecondary))),
            ],
          ),
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
            for (final h in record.history) ...[
              _row('${h.type} · ${h.at.length >= 10 ? h.at.substring(0, 10) : h.at}${h.reason == null ? '' : ' · ${h.reason}'}'),
              if (h.hasTrail)
                Padding(
                  padding: const EdgeInsets.only(left: 12, bottom: 4),
                  child: Text(
                    'said in capture ${h.captureId ?? 'unknown'}, understood by ${h.interpreter ?? 'unknown'}, proposal ${h.proposalId}, approved by ${h.approvedBy}${h.contract == null ? '' : ', ${h.contract} v${h.contractVersion ?? 1}'}',
                    key: Key('trail-${h.eventId}'),
                    style: const TextStyle(color: _textTertiary, fontSize: 11),
                  ),
                ),
            ],
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
