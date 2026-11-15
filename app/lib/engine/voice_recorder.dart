// What the assistant needs from a microphone, and nothing more: start, then stop and hand back the recording. The screen knows nothing about packages or files, so it is tested with a recorded recorder; the
// real one is lib/engine/voice_recorder_device.dart. The recording is only ever SENT to the engine's audio route (the engine hears it, shows what it heard, and a write is only ever held); nothing is read
// from it here.

/// One finished recording, ready to send.
class VoiceNote {
  final List<int> bytes;
  final String filename;
  final String contentType;
  const VoiceNote({required this.bytes, this.filename = 'note.m4a', this.contentType = 'audio/m4a'});
}

abstract class VoiceRecorder {
  /// Starts recording. False when the microphone cannot be used (no permission, no microphone): nothing is recording then.
  Future<bool> start();

  /// Stops and returns the recording; null when there is none.
  Future<VoiceNote?> stop();
}
