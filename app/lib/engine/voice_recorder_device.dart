// The real microphone for the assistant's voice button, on the `record` package. It only records and hands the bytes back (voice_recorder.dart); the engine hears them. On a phone the recording is an AAC .m4a
// in the temporary folder; in a browser it is Opus in a .webm. Nothing is kept by the app after the bytes are read.
import 'dart:io' show Directory;

import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:image_picker/image_picker.dart' show XFile;
import 'package:record/record.dart';

import 'voice_recorder.dart';

class DeviceVoiceRecorder implements VoiceRecorder {
  final AudioRecorder _recorder = AudioRecorder();

  @override
  Future<bool> start() async {
    if (!await _recorder.hasPermission()) return false;
    final path = kIsWeb ? '' : '${Directory.systemTemp.path}/note-${DateTime.now().microsecondsSinceEpoch}.m4a';
    await _recorder.start(RecordConfig(encoder: kIsWeb ? AudioEncoder.opus : AudioEncoder.aacLc), path: path);
    return true;
  }

  @override
  Future<VoiceNote?> stop() async {
    final path = await _recorder.stop();
    if (path == null || path.isEmpty) return null;
    final bytes = await XFile(path).readAsBytes();
    return VoiceNote(bytes: bytes, filename: kIsWeb ? 'note.webm' : 'note.m4a', contentType: kIsWeb ? 'audio/webm' : 'audio/m4a');
  }
}
