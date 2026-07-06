import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'package:path_provider/path_provider.dart';
import 'package:record/record.dart';

/// The one thing every future client (Flutter, PWA, desktop) points at.
/// Changing this one line is the entire cost of a future domain swap.
const officeApiBase = 'https://office.websitehub.co.za';

void main() => runApp(const OfficeApp());

class OfficeApp extends StatelessWidget {
  const OfficeApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'The Office',
      theme: ThemeData(
        colorSchemeSeed: const Color(0xFF2D6A4F),
        useMaterial3: true,
      ),
      home: const OfficeHome(),
    );
  }
}

enum MessageRole { user, office, status }

class ChatMessage {
  final String id;
  MessageRole role;
  String text;
  ChatMessage({required this.id, required this.role, required this.text});
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

  void _updateMessage(String id, {MessageRole? role, required String text}) {
    final index = _messages.indexWhere((m) => m.id == id);
    if (index == -1) return;
    setState(() {
      if (role != null) _messages[index].role = role;
      _messages[index].text = text;
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

  // --- Type mode ---------------------------------------------------

  Future<void> _sendText() async {
    final text = _textController.text.trim();
    if (text.isEmpty) return;
    _textController.clear();

    _addMessage(MessageRole.user, text);
    final statusId = _addMessage(MessageRole.status, 'Reading that...');
    _startStatusCycle(statusId, ['Reading that...', 'Checking who you meant...', 'Writing it down...']);

    try {
      final uri = Uri.parse('$officeApiBase/messages/text');
      final response = await http.post(
        uri,
        headers: {'Content-Type': 'application/json'},
        body: jsonEncode({'text': text}),
      );
      _stopStatusCycle();

      if (response.statusCode == 200) {
        final data = jsonDecode(response.body) as Map<String, dynamic>;
        _updateMessage(statusId, role: MessageRole.office, text: data['message'] as String? ?? 'Done.');
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
      final streamed = await request.send();
      final response = await http.Response.fromStream(streamed);
      _stopStatusCycle();

      if (response.statusCode == 200) {
        final data = jsonDecode(response.body) as Map<String, dynamic>;
        final transcript = data['transcript'] as String?;
        if (transcript != null && transcript.trim().isNotEmpty) {
          _updateMessage(userId, text: transcript);
        }
        _updateMessage(statusId, role: MessageRole.office, text: data['message'] as String? ?? 'Done.');
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

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Office')),
      body: SafeArea(
        child: Column(
          children: [
            Expanded(
              child: ListView.builder(
                controller: _scrollController,
                padding: const EdgeInsets.all(12),
                itemCount: _messages.length,
                itemBuilder: (context, i) => _MessageBubble(message: _messages[i]),
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

class _MessageBubble extends StatelessWidget {
  final ChatMessage message;
  const _MessageBubble({required this.message});

  @override
  Widget build(BuildContext context) {
    final isUser = message.role == MessageRole.user;
    final isStatus = message.role == MessageRole.status;

    final bubbleColor = isUser
        ? Theme.of(context).colorScheme.primaryContainer
        : isStatus
            ? Colors.transparent
            : Theme.of(context).colorScheme.surfaceContainerHighest;

    final textStyle = isStatus
        ? TextStyle(color: Colors.grey.shade600, fontStyle: FontStyle.italic)
        : const TextStyle();

    return Align(
      alignment: isUser ? Alignment.centerRight : Alignment.centerLeft,
      child: Container(
        margin: const EdgeInsets.symmetric(vertical: 4),
        padding: isStatus ? const EdgeInsets.symmetric(horizontal: 4, vertical: 6) : const EdgeInsets.all(12),
        constraints: BoxConstraints(maxWidth: MediaQuery.of(context).size.width * 0.78),
        decoration: isStatus
            ? null
            : BoxDecoration(
                color: bubbleColor,
                borderRadius: BorderRadius.circular(16),
              ),
        child: Text(message.text, style: textStyle),
      ),
    );
  }
}

// Bottom-anchored, thumb-reachable — mic and text live in the same
// composer bar, same reasoning as any chat interface: the primary
// action should never require repositioning your grip on the phone.
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
      child: Padding(
        padding: const EdgeInsets.fromLTRB(8, 8, 8, 8),
        child: Row(
          children: [
            IconButton(
              iconSize: 30,
              icon: Icon(isRecording ? Icons.stop_circle : Icons.mic),
              color: isRecording ? Colors.red : null,
              onPressed: onMicTap,
            ),
            Expanded(
              child: TextField(
                controller: controller,
                textInputAction: TextInputAction.send,
                onSubmitted: (_) => onSend(),
                decoration: InputDecoration(
                  hintText: 'Type or tap the mic...',
                  filled: true,
                  contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
                  border: OutlineInputBorder(borderRadius: BorderRadius.circular(24), borderSide: BorderSide.none),
                ),
              ),
            ),
            IconButton(
              iconSize: 28,
              icon: const Icon(Icons.arrow_upward),
              onPressed: onSend,
            ),
          ],
        ),
      ),
    );
  }
}

