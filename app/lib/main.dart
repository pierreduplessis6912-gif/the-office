import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:http/http.dart' as http;
import 'package:path_provider/path_provider.dart';
import 'package:record/record.dart';

/// The one thing every future client (Flutter, PWA, desktop) points at.
/// Changing this one line is the entire cost of a future domain swap.
const officeApiBase = 'https://office.websitehub.co.za';

// Design tokens. Grounded in the actual subject — an invoice book and
// a work order, not a generic messaging app — rather than Material's
// auto-derived defaults. See design plan: aged ledger paper, ballpoint
// ink, workwear pine (the Office), leather brown (Peter), stamp red
// reserved for anything still waiting on a decision.
const _paper = Color(0xFFF2ECDC);
const _ink = Color(0xFF2B2620);
const _officeAccent = Color(0xFF1F4B3F);
const _userAccent = Color(0xFF6B4A2B);
const _stampRed = Color(0xFFB23A2E);
const _muted = Color(0xFF8A8172);
const _confirmedGreen = Color(0xFF2F6B4F);

void main() => runApp(const OfficeApp());

class OfficeApp extends StatelessWidget {
  const OfficeApp({super.key});

  @override
  Widget build(BuildContext context) {
    final base = ThemeData.light();
    return MaterialApp(
      title: 'The Office',
      theme: ThemeData(
        useMaterial3: true,
        scaffoldBackgroundColor: _paper,
        colorScheme: ColorScheme.fromSeed(
          seedColor: _officeAccent,
          brightness: Brightness.light,
        ).copyWith(surface: _paper),
        textTheme: GoogleFonts.workSansTextTheme(base.textTheme).apply(
          bodyColor: _ink,
          displayColor: _ink,
        ),
        appBarTheme: AppBarTheme(
          backgroundColor: _paper,
          foregroundColor: _ink,
          elevation: 0,
          scrolledUnderElevation: 0,
          titleTextStyle: GoogleFonts.ibmPlexMono(
            color: _ink,
            fontWeight: FontWeight.w600,
            fontSize: 19,
            letterSpacing: 1.8,
          ),
        ),
      ),
      home: const OfficeHome(),
    );
  }
}

enum MessageRole { user, office, status }

enum PendingStatus { pending, confirmed, rejected }

// A single guard()-held item riding on a message — a payment, an
// invoice, a quotation, a structured fact. A message can carry more
// than one (e.g. a quotation AND an address, both awaiting separate
// confirmation), so this lives as a list, not a single flag.
class PendingItem {
  final int id;
  PendingStatus status;
  bool busy;
  PendingItem({required this.id, this.status = PendingStatus.pending, this.busy = false});
}

class ChatMessage {
  final String id;
  MessageRole role;
  String text;
  List<PendingItem> pendingItems;
  ChatMessage({
    required this.id,
    required this.role,
    required this.text,
    List<PendingItem>? pendingItems,
  }) : pendingItems = pendingItems ?? [];
}

class OfficeHome extends StatefulWidget {
  const OfficeHome({super.key});

  @override
  State<OfficeHome> createState() => _OfficeHomeState();
}

class _OfficeHomeState extends State<OfficeHome> {
  final _recorder = AudioRecorder();
  final _textController = TextEditingController();
  final _scrollController = ScrollController();

  bool _isRecording = false;
  int _idCounter = 0;

  final List<ChatMessage> _messages = [
    ChatMessage(id: 'seed-1', role: MessageRole.office, text: 'Morning Peter — talk or type, whichever is easier.'),
  ];

  Timer? _statusTimer;

  @override
  void dispose() {
    _recorder.dispose();
    _textController.dispose();
    _scrollController.dispose();
    _statusTimer?.cancel();
    super.dispose();
  }

  String _newId() => 'msg-${_idCounter++}';

  String _addMessage(MessageRole role, String text) {
    final id = _newId();
    setState(() => _messages.add(ChatMessage(id: id, role: role, text: text)));
    _scrollToEnd();
    return id;
  }

  void _updateMessage(String id, {MessageRole? role, required String text, List<PendingItem>? pendingItems}) {
    final index = _messages.indexWhere((m) => m.id == id);
    if (index == -1) return;
    setState(() {
      if (role != null) _messages[index].role = role;
      _messages[index].text = text;
      if (pendingItems != null) _messages[index].pendingItems = pendingItems;
    });
    _scrollToEnd();
  }

  void _scrollToEnd() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!_scrollController.hasClients) return;
      _scrollController.animateTo(
        _scrollController.position.maxScrollExtent,
        duration: const Duration(milliseconds: 200),
        curve: Curves.easeOut,
      );
    });
  }

  // Live, rotating description of what's actually happening — not a
  // generic spinner. Cancelled the moment a real response arrives.
  void _startStatusCycle(String statusId, List<String> phrases) {
    var i = 0;
    _statusTimer?.cancel();
    _statusTimer = Timer.periodic(const Duration(milliseconds: 1100), (_) {
      i = (i + 1) % phrases.length;
      _updateMessage(statusId, text: phrases[i]);
    });
  }

  void _stopStatusCycle() {
    _statusTimer?.cancel();
    _statusTimer = null;
  }

  // The actual fix for the query-rewriting gap: the backend has been
  // able to resolve "her" -> "Jenny" using history since yesterday,
  // but nothing in the app ever sent any history to use. Last 3
  // exchanges (6 messages), skipping status lines — those were never
  // really said by anyone, just narration of waiting.
  List<Map<String, String>> _recentHistory() {
    final real = _messages.where((m) => m.role != MessageRole.status).toList();
    final recent = real.length > 6 ? real.sublist(real.length - 6) : real;
    return recent
        .map((m) => {'role': m.role == MessageRole.user ? 'user' : 'office', 'text': m.text})
        .toList();
  }

  List<PendingItem> _extractPendingItems(Map<String, dynamic> data) {
    final items = <PendingItem>[];
    final pendingActionId = data['pendingActionId'];
    if (pendingActionId is int) items.add(PendingItem(id: pendingActionId));
    final factPendingActionId = data['factPendingActionId'];
    if (factPendingActionId is int) items.add(PendingItem(id: factPendingActionId));
    return items;
  }

  // --- Type mode ---------------------------------------------------

  Future<void> _sendText() async {
    final text = _textController.text.trim();
    if (text.isEmpty) return;
    _textController.clear();

    final history = _recentHistory();
    _addMessage(MessageRole.user, text);
    final statusId = _addMessage(MessageRole.status, 'Reading that...');
    _startStatusCycle(statusId, ['Reading that...', 'Checking who you meant...', 'Writing it down...']);

    try {
      final uri = Uri.parse('$officeApiBase/messages/text');
      final response = await http.post(
        uri,
        headers: {'Content-Type': 'application/json'},
        body: jsonEncode({'text': text, 'history': history}),
      );
      _stopStatusCycle();

      if (response.statusCode == 200) {
        final data = jsonDecode(response.body) as Map<String, dynamic>;
        _updateMessage(
          statusId,
          role: MessageRole.office,
          text: data['message'] as String? ?? 'Done.',
          pendingItems: _extractPendingItems(data),
        );
      } else {
        _updateMessage(statusId, role: MessageRole.office, text: 'Something went wrong (${response.statusCode}).');
      }
    } catch (_) {
      _stopStatusCycle();
      _updateMessage(statusId, role: MessageRole.office, text: 'Could not reach the Office — check connection.');
    }
  }

  // --- Talk mode -----------------------------------------------------

  Future<void> _toggleRecording() async {
    try {
      if (_isRecording) {
        final path = await _recorder.stop();
        setState(() => _isRecording = false);
        if (path != null) {
          await _handleRecording(path);
        }
        return;
      }

      if (!await _recorder.hasPermission()) {
        _addMessage(MessageRole.office, 'Microphone permission denied.');
        return;
      }

      final dir = await getTemporaryDirectory();
      final path = '${dir.path}/note_${DateTime.now().millisecondsSinceEpoch}.m4a';
      await _recorder.start(const RecordConfig(), path: path);
      setState(() => _isRecording = true);
    } catch (e, stack) {
      // Surface the real error instead of failing silently — this is
      // a diagnostic addition specifically to find out what's actually
      // breaking on web, not a permanent behavior.
      setState(() => _isRecording = false);
      _addMessage(MessageRole.office, 'Mic error: $e');
      debugPrint('Mic error: $e\n$stack');
    }
  }

  Future<void> _handleRecording(String path) async {
    final history = _recentHistory();

    // Acknowledge instantly — we don't have the real words yet (no live
    // on-device transcript wired in this version), so a voice-message
    // placeholder stands in until the real transcript comes back and
    // replaces it. Same pattern WhatsApp uses for voice notes, just
    // temporary here rather than permanent.
    final userId = _addMessage(MessageRole.user, '🎤 Voice message');
    final statusId = _addMessage(MessageRole.status, 'Transcribing...');
    _startStatusCycle(statusId, ['Transcribing...', 'Checking who you meant...', 'Writing it down...']);

    try {
      final uri = Uri.parse('$officeApiBase/files/audio');
      final request = http.MultipartRequest('POST', uri);
      request.files.add(await http.MultipartFile.fromPath('audio', path));
      request.fields['history'] = jsonEncode(history);
      final streamed = await request.send();
      final response = await http.Response.fromStream(streamed);
      _stopStatusCycle();

      if (response.statusCode == 200) {
        final data = jsonDecode(response.body) as Map<String, dynamic>;
        final transcript = data['transcript'] as String?;
        if (transcript != null && transcript.trim().isNotEmpty) {
          _updateMessage(userId, text: transcript);
        }
        _updateMessage(
          statusId,
          role: MessageRole.office,
          text: data['message'] as String? ?? 'Done.',
          pendingItems: _extractPendingItems(data),
        );
      } else {
        _updateMessage(statusId, role: MessageRole.office, text: 'Upload failed (${response.statusCode}).');
      }
    } catch (_) {
      _stopStatusCycle();
      _updateMessage(statusId, role: MessageRole.office, text: 'Upload failed — check connection.');
    } finally {
      try {
        await File(path).delete();
      } catch (_) {
        // Not critical if cleanup fails.
      }
    }
  }

  // --- Guard() actions — the actual point of today's build ----------

  Future<void> _resolvePendingItem(String messageId, int itemId, bool confirm) async {
    final msgIndex = _messages.indexWhere((m) => m.id == messageId);
    if (msgIndex == -1) return;
    final itemIndex = _messages[msgIndex].pendingItems.indexWhere((p) => p.id == itemId);
    if (itemIndex == -1) return;

    setState(() => _messages[msgIndex].pendingItems[itemIndex].busy = true);

    try {
      final uri = Uri.parse('$officeApiBase/actions/$itemId/${confirm ? "confirm" : "reject"}');
      final response = await http.post(uri);
      setState(() {
        _messages[msgIndex].pendingItems[itemIndex].busy = false;
        _messages[msgIndex].pendingItems[itemIndex].status =
            response.statusCode == 200
                ? (confirm ? PendingStatus.confirmed : PendingStatus.rejected)
                : PendingStatus.pending;
      });
      if (response.statusCode != 200) {
        _addMessage(MessageRole.office, 'Could not ${confirm ? "confirm" : "reject"} that — try again.');
      }
    } catch (_) {
      setState(() => _messages[msgIndex].pendingItems[itemIndex].busy = false);
      _addMessage(MessageRole.office, 'Could not reach the Office to ${confirm ? "confirm" : "reject"} that.');
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('THE OFFICE')),
      body: SafeArea(
        child: Column(
          children: [
            Expanded(
              child: ListView.builder(
                controller: _scrollController,
                padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
                itemCount: _messages.length,
                itemBuilder: (context, i) => _MessageLine(
                  message: _messages[i],
                  onConfirm: (itemId) => _resolvePendingItem(_messages[i].id, itemId, true),
                  onReject: (itemId) => _resolvePendingItem(_messages[i].id, itemId, false),
                ),
              ),
            ),
            _Composer(
              controller: _textController,
              isRecording: _isRecording,
              onSend: _sendText,
              onMicTap: _toggleRecording,
            ),
          ],
        ),
      ),
    );
  }
}

// Not a chat bubble — a ledger line. Each entry is a small-caps mono
// label, a colored accent stripe identifying who wrote it, and the
// message in a plain, highly legible body face.
class _MessageLine extends StatelessWidget {
  final ChatMessage message;
  final void Function(int itemId) onConfirm;
  final void Function(int itemId) onReject;

  const _MessageLine({required this.message, required this.onConfirm, required this.onReject});

  @override
  Widget build(BuildContext context) {
    if (message.role == MessageRole.status) {
      return _buildStatus();
    }
    if (message.pendingItems.isNotEmpty) {
      return _buildStamp();
    }
    return _buildLine();
  }

  Widget _buildLine() {
    final isUser = message.role == MessageRole.user;
    final accent = isUser ? _userAccent : _officeAccent;
    final label = isUser ? 'PETER' : 'OFFICE';

    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 10),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Container(
            width: 3,
            height: 20,
            margin: const EdgeInsets.only(top: 3, right: 10),
            color: accent,
          ),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  label,
                  style: GoogleFonts.ibmPlexMono(
                    fontSize: 11,
                    fontWeight: FontWeight.w600,
                    letterSpacing: 1.4,
                    color: accent,
                  ),
                ),
                const SizedBox(height: 3),
                Text(
                  message.text,
                  style: GoogleFonts.workSans(fontSize: 15.5, color: _ink, height: 1.35),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildStatus() {
    return Padding(
      padding: const EdgeInsets.only(left: 13, top: 4, bottom: 10),
      child: Row(
        children: [
          const SizedBox(
            width: 12,
            height: 12,
            child: CircularProgressIndicator(strokeWidth: 1.6, color: _muted),
          ),
          const SizedBox(width: 8),
          Text(
            message.text.toUpperCase(),
            style: GoogleFonts.ibmPlexMono(fontSize: 11.5, color: _muted, letterSpacing: 0.8),
          ),
        ],
      ),
    );
  }

  // The signature element: anything guard() has held for confirmation
  // renders as a literal, rotated, dashed-ink stamp — driven by the
  // real pendingActionId/factPendingActionId fields from the API now,
  // not by matching words in the message text. A message can carry
  // more than one item (e.g. a quotation and a fact), each with its
  // own Confirm/Reject buttons and its own resolved state.
  Widget _buildStamp() {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 12),
      child: Align(
        alignment: Alignment.centerLeft,
        child: Transform.rotate(
          angle: -0.035,
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
            constraints: const BoxConstraints(maxWidth: 320),
            decoration: BoxDecoration(
              border: Border.all(color: _stampColorFor(message.pendingItems), width: 2),
              borderRadius: BorderRadius.circular(4),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  _stampLabelFor(message.pendingItems),
                  style: GoogleFonts.ibmPlexMono(
                    fontSize: 11,
                    fontWeight: FontWeight.w700,
                    letterSpacing: 1.6,
                    color: _stampColorFor(message.pendingItems),
                  ),
                ),
                const SizedBox(height: 5),
                Text(
                  message.text,
                  style: GoogleFonts.workSans(fontSize: 14, color: _ink, height: 1.3),
                ),
                const SizedBox(height: 10),
                ...message.pendingItems.map(_buildActionRow),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Color _stampColorFor(List<PendingItem> items) {
    if (items.every((i) => i.status == PendingStatus.confirmed)) return _confirmedGreen;
    if (items.every((i) => i.status != PendingStatus.pending)) return _muted;
    return _stampRed;
  }

  String _stampLabelFor(List<PendingItem> items) {
    if (items.every((i) => i.status == PendingStatus.confirmed)) return 'CONFIRMED';
    if (items.every((i) => i.status != PendingStatus.pending)) return 'RESOLVED';
    return 'PENDING CONFIRMATION';
  }

  Widget _buildActionRow(PendingItem item) {
    if (item.status == PendingStatus.confirmed) {
      return Padding(
        padding: const EdgeInsets.only(top: 4),
        child: Text('✓ Confirmed (#${item.id})',
            style: GoogleFonts.ibmPlexMono(fontSize: 11, color: _confirmedGreen, fontWeight: FontWeight.w600)),
      );
    }
    if (item.status == PendingStatus.rejected) {
      return Padding(
        padding: const EdgeInsets.only(top: 4),
        child: Text('✕ Rejected (#${item.id})',
            style: GoogleFonts.ibmPlexMono(fontSize: 11, color: _muted, fontWeight: FontWeight.w600)),
      );
    }
    return Padding(
      padding: const EdgeInsets.only(top: 6),
      child: item.busy
          ? const SizedBox(height: 20, width: 20, child: CircularProgressIndicator(strokeWidth: 2, color: _stampRed))
          : Row(
              children: [
                _actionButton('Confirm', _confirmedGreen, () => onConfirm(item.id)),
                const SizedBox(width: 10),
                _actionButton('Reject', _muted, () => onReject(item.id)),
              ],
            ),
    );
  }

  Widget _actionButton(String label, Color color, VoidCallback onTap) {
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(4),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
        decoration: BoxDecoration(
          border: Border.all(color: color, width: 1.5),
          borderRadius: BorderRadius.circular(4),
        ),
        child: Text(
          label.toUpperCase(),
          style: GoogleFonts.ibmPlexMono(fontSize: 11, fontWeight: FontWeight.w700, letterSpacing: 1, color: color),
        ),
      ),
    );
  }
}

// Bottom-anchored, thumb-reachable, and styled as "write on the line"
// rather than a filled rounded pill — an underline, not chrome, to
// stay consistent with the ledger metaphor instead of borrowing a
// generic messaging-app composer.
class _Composer extends StatelessWidget {
  final TextEditingController controller;
  final bool isRecording;
  final VoidCallback onSend;
  final VoidCallback onMicTap;

  const _Composer({
    required this.controller,
    required this.isRecording,
    required this.onSend,
    required this.onMicTap,
  });

  @override
  Widget build(BuildContext context) {
    return SafeArea(
      top: false,
      child: Container(
        padding: const EdgeInsets.fromLTRB(12, 10, 12, 10),
        decoration: const BoxDecoration(
          border: Border(top: BorderSide(color: Color(0x332B2620), width: 1)),
        ),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.end,
          children: [
            IconButton(
              iconSize: 26,
              icon: Icon(isRecording ? Icons.stop_circle : Icons.mic_none),
              color: isRecording ? _stampRed : _officeAccent,
              onPressed: onMicTap,
            ),
            Expanded(
              child: TextField(
                controller: controller,
                textInputAction: TextInputAction.send,
                onSubmitted: (_) => onSend(),
                style: GoogleFonts.workSans(fontSize: 15.5, color: _ink),
                decoration: InputDecoration(
                  hintText: 'Write it down, or tap the mic...',
                  hintStyle: GoogleFonts.workSans(color: _muted, fontStyle: FontStyle.italic, fontSize: 14.5),
                  isDense: true,
                  contentPadding: const EdgeInsets.symmetric(vertical: 10),
                  border: const UnderlineInputBorder(borderSide: BorderSide(color: Color(0x552B2620))),
                  enabledBorder: const UnderlineInputBorder(borderSide: BorderSide(color: Color(0x552B2620))),
                  focusedBorder: const UnderlineInputBorder(borderSide: BorderSide(color: _officeAccent, width: 1.5)),
                ),
              ),
            ),
            const SizedBox(width: 4),
            IconButton(
              iconSize: 24,
              icon: const Icon(Icons.arrow_upward),
              color: _officeAccent,
              onPressed: onSend,
            ),
          ],
        ),
      ),
    );
  }
}
