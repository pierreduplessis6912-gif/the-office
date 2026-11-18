// The engine screen on the REAL client, shown by main.dart ONLY when GET /auth/me says the signed-in business is an engine business (docs/decisions/app-connection.md, decision 2; lib/engine/engine_mode.dart).
// Four tabs: what is owed (the first slice), the assistant (a typed sentence, a voice note, a photo of a receipt or a bill), what is waiting for approval, and More (expenses, stock, bills to pay). It computes nothing: every figure, refusal and held action is the engine's own. A write is only
// ever PROPOSED and held; the person approves or declines on the card. Nothing here is built from anything but the address and the session it is given; the session is never stored or printed here.
import 'package:flutter/material.dart';

import 'assistant_panel.dart';
import 'capture_picker.dart';
import 'engine_api.dart';
import 'engine_shell.dart';
import 'expenses_room.dart';
import 'stock_room.dart';
import 'bills_room.dart';
import 'books_room.dart';
import 'bank_room.dart';
import 'orders_room.dart';
import 'invoices_room.dart';
import 'assistant_model.dart' show parseAttention;
import 'attention_room.dart';
import 'daily_summary.dart';
import 'daily_summary_platform.dart';
import 'jobs_room.dart';
import 'quotes_room.dart';
import 'parties_room.dart';
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

  /// The daily notification. Tests give a recorded one; the app gives the Android one (a no-op elsewhere).
  final DailySummary? dailySummary;

  /// How the person chooses a picture. When null, the camera or the gallery, by the person's choice.
  final Future<EngineCaptureFile?> Function()? pickPhoto;

  /// The microphone for the voice button. When null there is no voice button (tests, and any build without one).
  final VoiceRecorder? voiceRecorder;

  const EngineLiveHome({super.key, required this.baseUrl, required this.sessionToken, required this.onSignOut, this.apiFactory, this.dailySummary, this.pickPhoto, this.voiceRecorder});

  @override
  State<EngineLiveHome> createState() => _EngineLiveHomeState();
}

class _EngineLiveHomeState extends State<EngineLiveHome> {
  late final EngineApi _api = (widget.apiFactory ?? _realApi)(widget.baseUrl, widget.sessionToken);
  int _tab = 0;

  /// How many things the engine says need attention (0 when it cannot be read: no badge is better than a wrong one).
  int _attention = 0;
  late final DailySummary _summary = widget.dailySummary ?? createDailySummary();
  bool _summaryOn = false;

  @override
  void initState() {
    super.initState();
    _loadAttention();
    _loadSummary();
  }

  Future<void> _loadSummary() async {
    if (!_summary.supported) return;
    final on = await _summary.isOn();
    if (!mounted) return;
    setState(() => _summaryOn = on);
  }

  Future<void> _testSummary() async {
    SummaryMessage message;
    try {
      final response = await _api.attention();
      message = testSummaryMessage(parseAttention(response.status, response.body));
    } catch (_) {
      message = testSummaryMessage(null);
    }
    final shown = await _summary.showNow(message);
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(shown ? 'Test notification sent.' : 'Notifications are not allowed for this app. Allow them in the phone settings.')));
  }

  Future<void> _toggleSummary(bool want) async {
    if (want) {
      final ok = await _summary.turnOn(widget.baseUrl);
      if (!mounted) return;
      setState(() => _summaryOn = ok);
      if (!ok) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Notifications are not allowed for this app, so the daily summary stays off.')));
    } else {
      await _summary.turnOff();
      if (!mounted) return;
      setState(() => _summaryOn = false);
    }
  }

  Future<void> _loadAttention() async {
    int n = 0;
    try {
      final response = await _api.attention();
      n = parseAttention(response.status, response.body)?.count ?? 0;
    } catch (_) {
      n = 0;
    }
    if (!mounted || n == _attention) return;
    setState(() => _attention = n);
  }

  /// Which of the "More" rooms is open (null shows the list of them).
  String? _room;

  Widget _moreBody() {
    final room = _room;
    if (room != null) {
      final Widget child = switch (room) {
        'expenses' => ExpensesRoom(key: const ValueKey<String>('expenses-live'), api: _api),
        'stock' => StockRoom(key: const ValueKey<String>('stock-live'), api: _api),
        'orders' => OrdersRoom(key: const ValueKey<String>('orders-live'), api: _api),
        'books' => BooksRoom(key: const ValueKey<String>('books-live'), api: _api),
        'bank' => BankRoom(key: const ValueKey<String>('bank-live'), api: _api),
        'invoices' => InvoicesRoom(key: const ValueKey<String>('invoices-live'), api: _api),
        'attention' => AttentionRoom(key: const ValueKey<String>('attention-live'), api: _api),
        'jobs' => JobsRoom(key: const ValueKey<String>('jobs-live'), api: _api),
        'quotes' => QuotesRoom(key: const ValueKey<String>('quotes-live'), api: _api),
        'parties' => PartiesRoom(key: const ValueKey<String>('parties-live'), api: _api),
        _ => BillsRoom(key: const ValueKey<String>('bills-live'), api: _api),
      };
      return SafeArea(
        child: Column(children: [
          Align(alignment: Alignment.centerLeft, child: TextButton.icon(key: const Key('more-back'), onPressed: () { setState(() => _room = null); _loadAttention(); }, icon: const Icon(Icons.arrow_back), label: const Text('More'))),
          Expanded(child: child),
        ]),
      );
    }
    Widget tile(String key, IconData icon, String title) => ListTile(key: Key('more-$key'), leading: Icon(icon), title: Text(title), onTap: () => setState(() => _room = key));
    return SafeArea(
      child: ListView(padding: const EdgeInsets.all(12), children: [
        tile('attention', Icons.notifications_none, _attention > 0 ? 'Needs attention ($_attention)' : 'Needs attention'),
        tile('expenses', Icons.receipt_long_outlined, 'Expenses'),
        tile('stock', Icons.inventory_2_outlined, 'Stock'),
        tile('bills', Icons.request_quote_outlined, 'Bills to pay'),
        tile('orders', Icons.local_shipping_outlined, 'Orders waiting for goods'),
        tile('books', Icons.account_balance_outlined, 'The books'),
        tile('bank', Icons.savings_outlined, 'The bank'),
        tile('invoices', Icons.request_quote_outlined, 'Invoices'),
        tile('jobs', Icons.event_outlined, 'Jobs'),
        tile('quotes', Icons.description_outlined, 'Quotations'),
        tile('parties', Icons.people_outline, 'Customers and suppliers'),
        if (_summary.supported) SwitchListTile(key: const Key('more-daily-summary'), secondary: const Icon(Icons.notifications_active_outlined), title: const Text('Daily summary at 06:00'), subtitle: const Text('A notification saying what needs your attention.'), value: _summaryOn, onChanged: _toggleSummary),
        if (_summary.supported) ListTile(key: const Key('more-daily-summary-test'), leading: const Icon(Icons.send_outlined), title: const Text('Send a test notification now'), subtitle: const Text('Shows what the 06:00 summary would say, so you can check it works.'), onTap: _testSummary),
      ]),
    );
  }

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
      body: _tab == 3
          ? _moreBody()
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
                      child: IconButton(key: const Key('live-sign-out'), tooltip: 'Sign out', icon: const Icon(Icons.logout, color: Color(0xFF5A5A5F)), onPressed: () {
                        widget.onSignOut();
                        if (_summary.supported) _summary.turnOff();   // signing out ends the daily summary on this phone
                      }),
                    ),
                  ),
                ),
              ],
            )
          : SafeArea(child: AssistantPanel(key: const ValueKey<String>('assistant-live'), api: _api, footnote: footnote, pickPhoto: _choosePhoto, recorder: widget.voiceRecorder)),
      bottomNavigationBar: NavigationBar(
        key: const Key('live-tabs'),
        selectedIndex: _tab,
        onDestinationSelected: (i) {
          setState(() {
            _tab = i;
            if (i == 3) _room = null;
          });
          _loadAttention();
        },
        destinations: [
          const NavigationDestination(icon: Icon(Icons.account_balance_wallet_outlined), label: 'What is owed'),
          const NavigationDestination(icon: Icon(Icons.chat_bubble_outline), label: 'Assistant'),
          const NavigationDestination(icon: Icon(Icons.fact_check_outlined), label: 'To approve'),
          NavigationDestination(icon: Badge(key: const Key('more-badge'), isLabelVisible: _attention > 0, label: Text('$_attention'), child: const Icon(Icons.more_horiz)), label: 'More'),
        ],
      ),
    );
  }
}
