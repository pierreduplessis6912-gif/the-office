// The engine shell, first step of the visible slice (docs/decisions/first-slice.md, section B): the persistent orb, a typed question, and the answer card. A quiet black screen (DESIGN_CONSTITUTION_V2.md): one orb, nothing else until the
// person asks, and an answer that arrives as a card, not a chat bubble. THE SHELL COMPUTES NOTHING: every figure is formatted from the engine's whole-number minor units (slice_model.dart), and what a member may see is the engine's decision.
// A refusal is a boundary, never red; a business without the capability is told so honestly. Drill-down, the approval card and the trace sheet come in later steps. This file is not wired into main.dart.
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

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  Widget _content() {
    final answer = _flow.answer;
    switch (_flow.step) {
      case SliceStep.answered:
        return answer == null ? const SizedBox.shrink() : _AnswerCard(answer: answer);
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
  const _AnswerCard({required this.answer});

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
            Padding(
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
          const SizedBox(height: 8),
          Text('Source: ${answer.derivedBy}, account version ${answer.version}', style: const TextStyle(color: _textTertiary, fontSize: 11)),
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
