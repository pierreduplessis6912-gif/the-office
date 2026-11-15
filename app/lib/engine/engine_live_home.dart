// The engine screen on the REAL client, shown by main.dart ONLY when GET /auth/me says the signed-in business is an engine business (docs/decisions/app-connection.md, decision 2; lib/engine/engine_mode.dart).
// Two rooms: what is owed (the first slice) and the assistant (a typed sentence, a photo of a receipt or a bill). It computes nothing: every figure, refusal and held action is the engine's own. A write is only
// ever PROPOSED and held; the person approves or declines on the card. Nothing here is built from anything but the address and the session it is given; the session is never stored or printed here.
import 'package:flutter/material.dart';

import 'assistant_panel.dart';
import 'capture_picker.dart';
import 'engine_api.dart';
import 'engine_shell.dart';
import 'expenses_room.dart';
import 'stock_room.dart';
import 'http_engine_api.dart';
import 'pending_room.dart';
import 'voice_recorder.dart';

/// Builds the client from the address and the session. Tests give a recorded one; the app gives the real one.
typedef EngineApiFactory = EngineApi Function(String baseUrl, String sessionToken);

EngineApi _realApi(String baseUrl, String sessionToken) => HttpEngineApi(baseUrl: baseUrl, sessionToken: sessionToken);

class EngineLiveHome extends StatefulWidget {
  final String baseUrl;
  final String sessionToken;
  final VoidCallback onSignOut;
  final EngineApiFactory? apiFactory;

  /// How the person chooses a picture. When null, the camera or the gallery, by the person's choice.
  final Future<EngineCaptureFile?> Function()? pickPhoto;

  /// The microphone for the voice button. When null there is no voice button (tests, and any build without one).
  final VoiceRecorder? voiceRecorder;

  const EngineLiveHome({super.key, required this.baseUrl, required this.sessionToken, required this.onSignOut, this.apiFactory, this.pickPhoto, this.voiceRecorder});

  @override
  State<EngineLiveHome> createState() => _EngineLiveHomeState();
}

class _EngineLiveHomeState extends State<EngineLiveHome> {
  late final EngineApi _api = (widget.apiFactory ?? _realApi)(widget.baseUrl, widget.sessionToken);
  int _tab = 0;

  Future<EngineCaptureFile?> _choosePhoto() async {
    final custom = widget.pickPhoto;
    if (custom != null) return custom();
    final source = await showModalBottomSheet<String>(
      context: context,
      builder: (ctx) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            ListTile(key: const Key('pick-camera'), leading: const Icon(Icons.photo_camera_outlined), title: const Text('Take a photo'), onTap: () => Navigator.of(ctx).pop('camera')),
            ListTile(key: const Key('pick-gallery'), leading: const Icon(Icons.photo_library_outlined), title: const Text('Choose from the gallery'), onTap: () => Navigator.of(ctx).pop('gallery')),
          ],
        ),
      ),
    );
    if (source == 'camera') return pickFromCamera();
    if (source == 'gallery') return pickFromGallery();
    return null;
  }

  @override
  Widget build(BuildContext context) {
    const footnote = 'Connected to your business. Nothing is recorded until you approve it.';
    return Scaffold(
      backgroundColor: const Color(0xFF0A0A0B),
      body: _tab == 4
          ? StockRoom(key: const ValueKey<String>('stock-live'), api: _api)
          : _tab == 3
          ? ExpensesRoom(key: const ValueKey<String>('expenses-live'), api: _api)
          : _tab == 2
          ? PendingRoom(key: const ValueKey<String>('pending-live'), api: _api)
          : _tab == 0
          ? Stack(
              children: [
                EngineShell(api: _api, footnote: footnote),
                Positioned(
                  top: 4,
                  right: 4,
                  child: SafeArea(
                    child: Material(
                      type: MaterialType.transparency,
                      child: IconButton(key: const Key('live-sign-out'), tooltip: 'Sign out', icon: const Icon(Icons.logout, color: Color(0xFF5A5A5F)), onPressed: widget.onSignOut),
                    ),
                  ),
                ),
              ],
            )
          : SafeArea(child: AssistantPanel(key: const ValueKey<String>('assistant-live'), api: _api, footnote: footnote, pickPhoto: _choosePhoto, recorder: widget.voiceRecorder)),
      bottomNavigationBar: NavigationBar(
        key: const Key('live-tabs'),
        selectedIndex: _tab,
        onDestinationSelected: (i) => setState(() => _tab = i),
        destinations: const [
          NavigationDestination(icon: Icon(Icons.account_balance_wallet_outlined), label: 'What is owed'),
          NavigationDestination(icon: Icon(Icons.chat_bubble_outline), label: 'Assistant'),
          NavigationDestination(icon: Icon(Icons.fact_check_outlined), label: 'To approve'),
          NavigationDestination(icon: Icon(Icons.receipt_long_outlined), label: 'Expenses'),
          NavigationDestination(icon: Icon(Icons.inventory_2_outlined), label: 'Stock'),
        ],
      ),
    );
  }
}
