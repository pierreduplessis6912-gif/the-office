// The camera and the gallery for the assistant's capture buttons. It only hands back the bytes the person chose; what the picture IS (a receipt, a bill) is said by the person's button, never read off the picture.
import 'package:image_picker/image_picker.dart';

import 'assistant_panel.dart' show EngineCaptureFile;

String _contentTypeFor(String name) {
  final lower = name.toLowerCase();
  if (lower.endsWith('.png')) return 'image/png';
  return 'image/jpeg';
}

/// Takes a photo with the camera; null when the person cancels.
Future<EngineCaptureFile?> pickFromCamera({ImagePicker? picker}) async {
  final file = await (picker ?? ImagePicker()).pickImage(source: ImageSource.camera, imageQuality: 85, maxWidth: 2000);
  if (file == null) return null;
  return EngineCaptureFile(bytes: await file.readAsBytes(), filename: file.name, contentType: _contentTypeFor(file.name));
}

/// Chooses a photo from the gallery; null when the person cancels.
Future<EngineCaptureFile?> pickFromGallery({ImagePicker? picker}) async {
  final file = await (picker ?? ImagePicker()).pickImage(source: ImageSource.gallery, imageQuality: 85, maxWidth: 2000);
  if (file == null) return null;
  return EngineCaptureFile(bytes: await file.readAsBytes(), filename: file.name, contentType: _contentTypeFor(file.name));
}
