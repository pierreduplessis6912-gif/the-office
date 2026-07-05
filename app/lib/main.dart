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

class OfficeHome extends StatefulWidget {
  const OfficeHome({super.key});

  @override
  State<OfficeHome> createState() => _OfficeHomeState();
}

class _OfficeHomeState extends State<OfficeHome> {
  final _recorder = AudioRecorder();
  bool _isRecording = false;
  String _status = 'Morning Peter...';

  // Real voice notes get prepended here after a successful upload.
  // Still just a label, not a real transcript — that's a later step,
  // once transcription and an actual action function exist. This
  // milestone only proves: record real audio, send it, store it.
  final List<String> _recent = [
    'Morning Peter... you have a job at 09:00 in Eshowe.',
    'Jenny Hawkins invoice — 20% still outstanding.',
    'Reminder set: boys finish soccer at 14:00 on Wednesday.',
  ];

  @override
  void dispose() {
    _recorder.dispose();
    super.dispose();
  }

  Future<void> _toggleRecording() async {
    if (_isRecording) {
      final path = await _recorder.stop();
      setState(() {
        _isRecording = false;
        _status = 'Uploading...';
      });
      if (path != null) {
        await _uploadRecording(path);
      }
      return;
    }

    if (!await _recorder.hasPermission()) {
      setState(() => _status = 'Microphone permission denied');
      return;
    }

    final dir = await getTemporaryDirectory();
    final path =
        '${dir.path}/note_${DateTime.now().millisecondsSinceEpoch}.m4a';
    await _recorder.start(const RecordConfig(), path: path);
    setState(() {
      _isRecording = true;
      _status = 'Listening...';
    });
  }

  Future<void> _uploadRecording(String path) async {
    try {
      final uri = Uri.parse('$officeApiBase/files/audio');
      final request = http.MultipartRequest('POST', uri);
      request.files.add(await http.MultipartFile.fromPath('audio', path));
      final streamed = await request.send();
      final response = await http.Response.fromStream(streamed);

      if (response.statusCode == 200) {
        setState(() {
          _status = 'Morning Peter...';
          _recent.insert(
            0,
            'Voice note saved — '
            '${DateTime.now().toLocal().toString().substring(0, 16)}',
          );
        });
      } else {
        setState(() => _status = 'Upload failed (${response.statusCode})');
      }
    } catch (_) {
      setState(() => _status = 'Upload failed — check connection');
    } finally {
      // Local temp file has served its purpose once uploaded — the
      // real copy now lives in office-vault, not on this phone.
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
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Card(
                child: Padding(
                  padding: const EdgeInsets.all(16),
                  child: Row(
                    children: [
                      IconButton(
                        iconSize: 36,
                        icon: Icon(_isRecording ? Icons.stop_circle : Icons.mic),
                        color: _isRecording ? Colors.red : null,
                        onPressed: _toggleRecording,
                      ),
                      const SizedBox(width: 12),
                      Expanded(child: Text(_status)),
                    ],
                  ),
                ),
              ),
              const SizedBox(height: 24),
              const Text(
                'Recent conversations',
                style: TextStyle(fontWeight: FontWeight.bold, fontSize: 16),
              ),
              const SizedBox(height: 8),
              Expanded(
                child: ListView.separated(
                  itemCount: _recent.length,
                  separatorBuilder: (_, __) => const Divider(height: 1),
                  itemBuilder: (context, i) => ListTile(
                    leading: const Icon(Icons.chat_bubble_outline),
                    title: Text(_recent[i]),
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
