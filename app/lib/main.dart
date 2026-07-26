import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:http/http.dart' as http;
import 'package:image_picker/image_picker.dart';
import 'package:path_provider/path_provider.dart';
import 'package:record/record.dart';
import 'package:url_launcher/url_launcher.dart';

/// The one thing every future client (Flutter, PWA, desktop) points at.
/// Changing this one line is the entire cost of a future domain swap.
const officeApiBase = 'https://office.websitehub.co.za';

// Design tokens. Real, marrying two proven design threads rather than
// picking one: the "aged ledger" line-based rendering from the first
// Flutter build (no chat bubbles, ever), now on the dark, charcoal
// palette from the July manifesto prototype — the real, intended
// visual direction confirmed directly, not a stylistic guess. Five
// embers (real magnitude counts, never editorializing — see
// DECISIONS.md, "Peter must guide") replace the four from the
// original prototype, broadened to cover tonight's real, additional
// capabilities without growing the masthead further.
const _charcoal = Color(0xFF17140F);
const _paper = Color(0xFFF5F2EB);
const _muted = Color(0xFF8A8172);
const _officeAccent = Color(0xFF6FAF8F);
const _userAccent = Color(0xFFD9A868);
const _stampRed = Color(0xFFE0665A);
const _confirmedGreen = Color(0xFF6FAF8F);

// The five embers — real, deterministic magnitude, never urgency or
// judgment. Tasks folds in Snags (both a real, open "thing to do").
// Scheduler folds in Projects (a project is just grouped job scopes).
// Finance stays customer-side (receivables). Suppliers is Expenses,
// broadened to cover everything money-going-out (POs, GRN, supplier
// invoices/payments, Aged Creditors, Consumables Stock). Pending is
// new — the real, direct fulfillment of the original 2026-07-10
// "actions needed" ember concept, never actually wired into a UI
// until now.
const _emberAmber = Color(0xFFE8871E); // Tasks + Snags
const _emberBlue = Color(0xFF4A7FC1); // Scheduler + Projects
const _emberRed = Color(0xFFC4432B); // Finance
const _emberPurple = Color(0xFF7A5FB8); // Suppliers
const _emberSage = Color(0xFF5C7A5C); // Pending

void main() => runApp(const OfficeApp());

class OfficeApp extends StatelessWidget {
  const OfficeApp({super.key});

  @override
  Widget build(BuildContext context) {
    final base = ThemeData.dark();
    return MaterialApp(
      title: 'The Office',
      theme: ThemeData(
        useMaterial3: true,
        scaffoldBackgroundColor: _charcoal,
        colorScheme: ColorScheme.fromSeed(
          seedColor: _officeAccent,
          brightness: Brightness.dark,
        ).copyWith(surface: _charcoal),
        textTheme: GoogleFonts.workSansTextTheme(base.textTheme).apply(
          bodyColor: _paper,
          displayColor: _paper,
        ),
        appBarTheme: AppBarTheme(
          backgroundColor: _charcoal,
          foregroundColor: _paper,
          elevation: 0,
          scrolledUnderElevation: 0,
          titleTextStyle: GoogleFonts.ibmPlexMono(
            color: _paper,
            fontWeight: FontWeight.w600,
            fontSize: 19,
            letterSpacing: 1.8,
          ),
        ),
        drawerTheme: const DrawerThemeData(backgroundColor: _charcoal),
        popupMenuTheme: PopupMenuThemeData(
          color: _charcoal,
          textStyle: GoogleFonts.workSans(color: _paper, fontSize: 14),
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
  // Only set once confirmed, and only for invoice/quotation confirms
  // — the backend has always returned this, nothing on the client
  // ever did anything with it until now.
  String? pdfUrl;
  PendingItem({required this.id, this.status = PendingStatus.pending, this.busy = false, this.pdfUrl});
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

// The five real ember counts, plus the real, raw docket data behind
// each one — cached here so tapping an ember shows real detail
// without a separate round trip, since it was already fetched to
// compute the count in the first place.
class EmberCounts {
  int tasks;
  int scheduler;
  int finance;
  int suppliers;
  int pending;
  List<dynamic> tasksData = [];
  List<dynamic> snagsData = [];
  List<dynamic> schedulerData = [];
  List<dynamic> financeData = [];
  List<dynamic> expensesData = [];
  List<dynamic> creditorsData = [];
  List<dynamic> pendingData = [];
  EmberCounts({this.tasks = 0, this.scheduler = 0, this.finance = 0, this.suppliers = 0, this.pending = 0});
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
  final _imagePicker = ImagePicker();

  bool _isRecording = false;
  bool _isWriteMode = false;
  int _idCounter = 0;

  // Real feature 2026-07-26 — empty by default, no hardcoded seed
  // message. "Empty screen is relief" (Constitution Principle 25) —
  // the app should start genuinely empty, not with a pre-written
  // greeting standing in for it.
  final List<ChatMessage> _messages = [];

  final EmberCounts _embers = EmberCounts();

  Timer? _statusTimer;

  @override
  void initState() {
    super.initState();
    _loadEmberCounts();
  }

  @override
  void dispose() {
    _recorder.dispose();
    _textController.dispose();
    _scrollController.dispose();
    _statusTimer?.cancel();
    super.dispose();
  }

  // Real feature 2026-07-26 — the five embers wired to real, live
  // backend data. Fetched on startup and refreshed after every real
  // action, mirroring the manifesto prototype's own proven pattern.
  // Each ember reports a real, deterministic magnitude — never
  // editorializes, never asserts urgency (DECISIONS.md — "Peter must
  // guide"). Failures are silently ignored per-route rather than
  // shown as an error; a stale or missing count is a minor cosmetic
  // gap, not something worth interrupting Peter over.
  Future<void> _loadEmberCounts() async {
    Future<void> safeFetch(String path, void Function(Map<String, dynamic>) onData) async {
      try {
        final response = await http.get(Uri.parse('$officeApiBase$path'));
        if (response.statusCode == 200) {
          onData(jsonDecode(response.body) as Map<String, dynamic>);
        }
      } catch (_) {
        // Real, deliberate no-op — a stale ember count is a minor
        // cosmetic gap, not worth interrupting Peter with an error.
      }
    }

    await Future.wait([
      safeFetch('/embers/tasks', (data) {
        final tasksList = data['tasks'] as List? ?? [];
        final snags = data['openSnagsCount'] as int? ?? 0;
        setState(() {
          _embers.tasksData = tasksList;
          _embers.tasks = tasksList.length + snags;
        });
      }),
      safeFetch('/embers/scheduler', (data) {
        final scheduledList = data['scheduledToday'] as List? ?? [];
        final projects = data['projectsCount'] as int? ?? 0;
        setState(() {
          _embers.schedulerData = scheduledList;
          _embers.scheduler = scheduledList.length + projects;
        });
      }),
      safeFetch('/embers/finance', (data) {
        final outstandingList = data['outstanding'] as List? ?? [];
        setState(() {
          _embers.financeData = outstandingList;
          _embers.finance = outstandingList.length;
        });
      }),
      safeFetch('/embers/suppliers', (data) {
        final expensesList = data['todaysExpenses'] as List? ?? [];
        final creditorsList = data['agedCreditors'] as List? ?? [];
        setState(() {
          _embers.expensesData = expensesList;
          _embers.creditorsData = creditorsList;
          _embers.suppliers = expensesList.length + creditorsList.length;
        });
      }),
      safeFetch('/embers/pending', (data) {
        final pendingList = data['pending'] as List? ?? [];
        setState(() {
          _embers.pendingData = pendingList;
          _embers.pending = pendingList.length;
        });
      }),
    ]);
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
        _loadEmberCounts();
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
        _loadEmberCounts();
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

  // --- Photo & document upload (real feature 2026-07-26) --------------
  //
  // The single most significant gap named in UI_MAP.md: every other
  // real ingestion path (GRN reconciliation, supplier invoices,
  // supplier statements, the logo capture built earlier tonight)
  // depended on this, and until now nothing in the app could reach
  // it at all. Mirrors the exact real request shape already proven
  // live tonight via curl — a multipart "photo"/"document" field —
  // never a new backend contract, just the first real client for one
  // that already existed.

  Future<void> _pickAndSendPhoto() async {
    final XFile? picked = await _imagePicker.pickImage(source: ImageSource.camera, imageQuality: 85);
    if (picked == null) return;
    await _uploadFile(path: picked.path, endpoint: 'photo', fieldName: 'photo', label: '📷 Photo');
  }

  Future<void> _pickAndSendDocument() async {
    final result = await FilePicker.platform.pickFiles(type: FileType.custom, allowedExtensions: ['pdf', 'jpg', 'jpeg', 'png']);
    final path = result?.files.single.path;
    if (path == null) return;
    await _uploadFile(path: path, endpoint: 'document', fieldName: 'document', label: '📄 Document');
  }

  Future<void> _uploadFile({
    required String path,
    required String endpoint,
    required String fieldName,
    required String label,
  }) async {
    _addMessage(MessageRole.user, label);
    final statusId = _addMessage(MessageRole.status, 'Uploading...');
    _startStatusCycle(statusId, ['Uploading...', 'Reading it...', 'Checking who this is for...']);

    try {
      final uri = Uri.parse('$officeApiBase/files/$endpoint');
      final request = http.MultipartRequest('POST', uri);
      request.files.add(await http.MultipartFile.fromPath(fieldName, path));
      final streamed = await request.send();
      final response = await http.Response.fromStream(streamed);
      _stopStatusCycle();

      if (response.statusCode == 200) {
        final data = jsonDecode(response.body) as Map<String, dynamic>;
        // Real, honest surfacing of whichever real action the
        // ingestion pipeline actually produced — a supplier invoice
        // held for confirmation, a GRN recorded directly, a real
        // statement comparison, or none of those if there's genuinely
        // nothing real to reconcile against yet.
        final supplierInvoiceAction = data['supplierInvoiceAction'] as Map<String, dynamic>?;
        final goodsReceivedAction = data['goodsReceivedAction'] as Map<String, dynamic>?;
        final supplierStatementAction = data['supplierStatementAction'] as Map<String, dynamic>?;
        String message;
        List<PendingItem> pendingItems = [];
        if (supplierInvoiceAction != null) {
          final id = supplierInvoiceAction['pendingActionId'];
          message = 'Supplier invoice noted — needs your confirmation.';
          if (id is int) pendingItems = [PendingItem(id: id)];
        } else if (goodsReceivedAction != null) {
          message = 'Delivery recorded (GRN #${goodsReceivedAction['grnId']}).';
        } else if (supplierStatementAction != null) {
          final claimed = supplierStatementAction['claimedBalance'];
          final real = supplierStatementAction['realBalance'];
          message = 'Statement compared — they claim R$claimed, our records show R$real.';
        } else {
          message = 'Stored — nothing real to reconcile it against yet.';
        }
        _updateMessage(statusId, role: MessageRole.office, text: message, pendingItems: pendingItems);
        _loadEmberCounts();
      } else {
        _updateMessage(statusId, role: MessageRole.office, text: 'Upload failed (${response.statusCode}).');
      }
    } catch (_) {
      _stopStatusCycle();
      _updateMessage(statusId, role: MessageRole.office, text: 'Upload failed — check connection.');
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
      // Only invoice/quotation confirms carry a real pdfUrl — every
      // other confirm type (payment, customer_fact) simply won't have
      // one, which is fine, this stays null for those.
      String? pdfUrl;
      if (response.statusCode == 200 && confirm) {
        try {
          final data = jsonDecode(response.body) as Map<String, dynamic>;
          pdfUrl = data['pdfUrl'] as String?;
        } catch (_) {
          // Body wasn't valid JSON or didn't have the field — fine,
          // pdfUrl just stays null, nothing to surface.
        }
      }
      setState(() {
        _messages[msgIndex].pendingItems[itemIndex].busy = false;
        _messages[msgIndex].pendingItems[itemIndex].status =
            response.statusCode == 200
                ? (confirm ? PendingStatus.confirmed : PendingStatus.rejected)
                : PendingStatus.pending;
        _messages[msgIndex].pendingItems[itemIndex].pdfUrl = pdfUrl;
      });
      if (response.statusCode == 200) {
        _loadEmberCounts();
      } else {
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
      appBar: AppBar(
        title: const Text('THE OFFICE'),
        actions: [
          _EmberRow(embers: _embers, onEmberTap: _showEmberSheet),
          IconButton(
            icon: const Icon(Icons.more_vert),
            onPressed: () => _showMoreMenu(context),
          ),
        ],
      ),
      drawer: const _OfficeDrawer(),
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
              isWriteMode: _isWriteMode,
              onSend: () {
                _sendText();
                setState(() => _isWriteMode = false);
              },
              onMicTap: _toggleRecording,
              onCameraTap: _pickAndSendPhoto,
              onDocumentTap: _pickAndSendDocument,
              onToggleWriteMode: () => setState(() => _isWriteMode = !_isWriteMode),
              onDiscard: () {
                _textController.clear();
                setState(() => _isWriteMode = false);
              },
            ),
          ],
        ),
      ),
    );
  }

  // The three-dot menu — real, meta, account-level actions, not
  // business data. Mirrors this very interface's own convention
  // rather than inventing a new one. Login/settings/tutorials are
  // real, named destinations in UI_MAP.md — placeholder for now,
  // real wiring is a deliberate, separate next step.
  void _showMoreMenu(BuildContext context) {
    showMenu(
      context: context,
      position: const RelativeRect.fromLTRB(1000, 60, 0, 0),
      color: _charcoal,
      items: [
        const PopupMenuItem(value: 'account', child: Text('Account')),
        const PopupMenuItem(value: 'settings', child: Text('Settings')),
        const PopupMenuItem(value: 'help', child: Text('Help & tutorials')),
      ],
    );
  }

  // Real feature 2026-07-26 — the ember detail sheet, found missing
  // live when Pierre tapped an ember and nothing happened. Shows the
  // real, already-cached docket data for that domain — no separate
  // fetch, since it was already retrieved to compute the count.
  void _showEmberSheet(String emberId) {
    late String title;
    late List<Widget> cards;

    switch (emberId) {
      case 'tasks':
        title = 'TASKS';
        cards = _embers.tasksData
            .map((t) => _docketCard((t as Map<String, dynamic>)['description']?.toString() ?? 'Task'))
            .toList();
        break;
      case 'scheduler':
        title = 'SCHEDULER';
        cards = _embers.schedulerData.map((j) {
          final job = j as Map<String, dynamic>;
          return _docketCard('${job['customer_name'] ?? ''} — ${job['description'] ?? ''}');
        }).toList();
        break;
      case 'finance':
        title = 'FINANCE';
        cards = _embers.financeData.map((c) {
          final row = c as Map<String, dynamic>;
          final outstanding = (row['invoiced'] as num? ?? 0) - (row['paid'] as num? ?? 0);
          return _docketCard('${row['name']} — R$outstanding outstanding');
        }).toList();
        break;
      case 'suppliers':
        title = 'SUPPLIERS';
        cards = [
          ..._embers.expensesData.map((e) {
            final row = e as Map<String, dynamic>;
            return _docketCard('${row['description'] ?? 'Expense'} — R${row['amount']}');
          }),
          ..._embers.creditorsData.map((c) {
            final row = c as Map<String, dynamic>;
            return _docketCard('${row['supplierName'] ?? row['name'] ?? 'Supplier'} — R${row['total']} owed');
          }),
        ];
        break;
      case 'pending':
        title = 'PENDING';
        cards = _embers.pendingData.map((p) {
          final row = p as Map<String, dynamic>;
          return _docketCard('#${row['id']} — ${row['type'] ?? 'action'}');
        }).toList();
        break;
      default:
        title = '';
        cards = [];
    }

    showModalBottomSheet(
      context: context,
      backgroundColor: _charcoal,
      builder: (context) => SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                title,
                style: GoogleFonts.ibmPlexMono(color: _paper, fontSize: 14, fontWeight: FontWeight.w700, letterSpacing: 1.6),
              ),
              const SizedBox(height: 12),
              if (cards.isEmpty)
                Text('Nothing real here right now.', style: GoogleFonts.workSans(color: _muted, fontStyle: FontStyle.italic))
              else
                ConstrainedBox(
                  constraints: BoxConstraints(maxHeight: MediaQuery.of(context).size.height * 0.5),
                  child: ListView(shrinkWrap: true, children: cards),
                ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _docketCard(String text) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 6),
      child: Text(text, style: GoogleFonts.workSans(color: _paper, fontSize: 14.5)),
    );
  }
}

// The hamburger drawer — real navigation into existing data, mirroring
// this very interface's own sidebar. Reports & Documents and People
// were real, proven in the manifesto prototype; History joins them
// here rather than staying its own separate, poorly-discoverable
// swipe gesture (a real, named problem with the prior design — the
// handle blended into the background and the log itself used chat
// bubbles, which this whole rebuild deliberately moves away from).
// All three placeholder for now — real wiring is a deliberate,
// separate next step from this visual shell.
class _OfficeDrawer extends StatelessWidget {
  const _OfficeDrawer();

  @override
  Widget build(BuildContext context) {
    return Drawer(
      backgroundColor: _charcoal,
      child: SafeArea(
        child: ListView(
          padding: EdgeInsets.zero,
          children: [
            Padding(
              padding: const EdgeInsets.all(20),
              child: Text(
                'THE OFFICE',
                style: GoogleFonts.ibmPlexMono(color: _paper, fontSize: 16, letterSpacing: 1.6, fontWeight: FontWeight.w600),
              ),
            ),
            _drawerItem(Icons.description_outlined, 'Reports & Documents'),
            _drawerItem(Icons.people_outline, 'People'),
            _drawerItem(Icons.history, 'History'),
          ],
        ),
      ),
    );
  }

  Widget _drawerItem(IconData icon, String label) {
    return ListTile(
      leading: Icon(icon, color: _muted),
      title: Text(label, style: GoogleFonts.workSans(color: _paper, fontSize: 15)),
      onTap: () {},
    );
  }
}

// The five real embers — small, peripheral dots in the masthead, never
// competing for attention (Constitution Principle 25). Wired to real,
// live backend data; tapping one opens a real detail sheet. Real,
// tested values carried forward from the manifesto's own actual
// refinement history (found via its real commit log, not guessed):
// a 20x44 tap target (height matters most for touch targets in a row
// like this, width stays narrow so the dots still cluster close), and
// an elongated 4x15 slit rather than a round dot — "the tiger's-eye
// look."
const _emberUnlit = Color(0xFF2A2620);

class _EmberRow extends StatelessWidget {
  final EmberCounts embers;
  final void Function(String emberId) onEmberTap;
  const _EmberRow({required this.embers, required this.onEmberTap});

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        _Ember(color: _emberAmber, count: embers.tasks, onTap: () => onEmberTap('tasks')),
        _Ember(color: _emberBlue, count: embers.scheduler, onTap: () => onEmberTap('scheduler')),
        _Ember(color: _emberRed, count: embers.finance, onTap: () => onEmberTap('finance')),
        _Ember(color: _emberPurple, count: embers.suppliers, onTap: () => onEmberTap('suppliers')),
        _Ember(color: _emberSage, count: embers.pending, onTap: () => onEmberTap('pending')),
      ],
    );
  }
}

class _Ember extends StatelessWidget {
  final Color color;
  final int count;
  final VoidCallback onTap;
  const _Ember({required this.color, required this.count, required this.onTap});

  @override
  Widget build(BuildContext context) {
    // Real, tested tiers, exact thresholds carried forward from the
    // manifesto's own real JS logic — never a flat lit/unlit, real
    // magnitude shown as real brightness.
    final double brightness;
    final Color core;
    if (count >= 6) {
      brightness = 1.35;
      core = color;
    } else if (count >= 3) {
      brightness = 1.0;
      core = color;
    } else if (count >= 1) {
      brightness = 0.7;
      core = color;
    } else {
      brightness = 1.0;
      core = _emberUnlit;
    }
    return InkWell(
      onTap: onTap,
      child: SizedBox(
        width: 20,
        height: 44,
        child: Center(
          child: Container(
            width: 4,
            height: 15,
            decoration: BoxDecoration(
              color: count > 0 ? Color.lerp(core, Colors.white, (brightness - 1).clamp(0, 1) * 0.4) ?? core : core,
              borderRadius: BorderRadius.circular(2),
              boxShadow: count > 0
                  ? [BoxShadow(color: color.withOpacity(0.5), blurRadius: 6 * brightness, spreadRadius: 1)]
                  : null,
            ),
          ),
        ),
      ),
    );
  }
}

// Bottom-anchored, thumb-reachable composer — talk and write converge
// on the same real send path. Camera and document buttons added
// 2026-07-26, real, direct upload to /files/photo and /files/document
// — the single most significant gap this rebuild exists to close.
class _Composer extends StatelessWidget {
  final TextEditingController controller;
  final bool isRecording;
  final bool isWriteMode;
  final VoidCallback onSend;
  final VoidCallback onMicTap;
  final VoidCallback onCameraTap;
  final VoidCallback onDocumentTap;
  final VoidCallback onToggleWriteMode;
  final VoidCallback onDiscard;

  const _Composer({
    required this.controller,
    required this.isRecording,
    required this.isWriteMode,
    required this.onSend,
    required this.onMicTap,
    required this.onCameraTap,
    required this.onDocumentTap,
    required this.onToggleWriteMode,
    required this.onDiscard,
  });

  @override
  Widget build(BuildContext context) {
    return SafeArea(
      top: false,
      child: Container(
        padding: const EdgeInsets.fromLTRB(16, 10, 16, 14),
        // Real, tested design carried forward from the manifesto's own
        // history: no permanent text field, no hint text ("once the
        // icons are self-explanatory, instructional text was redundant
        // clutter competing with the void's own emptiness"). Talk mode
        // is the real, default state; write mode is a genuine, distinct
        // mode switched into, not a field sitting there all along.
        child: isWriteMode ? _buildWriteMode() : _buildTalkRow(),
      ),
    );
  }

  Widget _buildTalkRow() {
    return Row(
      mainAxisAlignment: MainAxisAlignment.spaceBetween,
      children: [
        Row(
          children: [
            IconButton(icon: const Icon(Icons.camera_alt_outlined), color: _muted, onPressed: onCameraTap),
            IconButton(icon: const Icon(Icons.attach_file), color: _muted, onPressed: onDocumentTap),
          ],
        ),
        IconButton(
          iconSize: 34,
          icon: Icon(isRecording ? Icons.stop_circle : Icons.mic_none),
          color: isRecording ? _stampRed : _officeAccent,
          onPressed: onMicTap,
        ),
        IconButton(icon: const Icon(Icons.edit_outlined), color: _muted, onPressed: onToggleWriteMode),
      ],
    );
  }

  Widget _buildWriteMode() {
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          'WRITE IT DOWN',
          style: GoogleFonts.ibmPlexMono(color: _muted, fontSize: 11, letterSpacing: 1.4, fontWeight: FontWeight.w600),
        ),
        const SizedBox(height: 6),
        // Real, tested fix: no visible border at all — "even a subtle
        // line read as input-field chrome against an otherwise
        // line-free void."
        TextField(
          controller: controller,
          autofocus: true,
          maxLines: 3,
          minLines: 2,
          style: GoogleFonts.workSans(fontSize: 15.5, color: _paper),
          decoration: const InputDecoration(
            border: InputBorder.none,
            isDense: true,
            contentPadding: EdgeInsets.zero,
          ),
        ),
        const SizedBox(height: 8),
        Row(
          mainAxisAlignment: MainAxisAlignment.end,
          children: [
            TextButton(onPressed: onDiscard, child: Text('DISCARD', style: GoogleFonts.ibmPlexMono(color: _muted, fontSize: 12, letterSpacing: 1))),
            const SizedBox(width: 8),
            TextButton(onPressed: onSend, child: Text('SEND', style: GoogleFonts.ibmPlexMono(color: _officeAccent, fontSize: 12, fontWeight: FontWeight.w700, letterSpacing: 1))),
          ],
        ),
      ],
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
                  style: GoogleFonts.workSans(fontSize: 15.5, color: _paper, height: 1.35),
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
                  style: GoogleFonts.workSans(fontSize: 14, color: _paper, height: 1.3),
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
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: [
            Text('✓ Confirmed (#${item.id})',
                style: GoogleFonts.ibmPlexMono(fontSize: 11, color: _confirmedGreen, fontWeight: FontWeight.w600)),
            if (item.pdfUrl != null)
              Padding(
                padding: const EdgeInsets.only(top: 6),
                child: InkWell(
                  onTap: () => launchUrl(Uri.parse(item.pdfUrl!), webOnlyWindowName: '_blank'),
                  child: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Icon(Icons.description_outlined, size: 14, color: _officeAccent),
                      const SizedBox(width: 5),
                      Text(
                        'VIEW DOCUMENT',
                        style: GoogleFonts.ibmPlexMono(
                          fontSize: 11,
                          fontWeight: FontWeight.w700,
                          letterSpacing: 1,
                          color: _officeAccent,
                          decoration: TextDecoration.underline,
                        ),
                      ),
                    ],
                  ),
                ),
              ),
          ],
        ),
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
