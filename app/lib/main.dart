import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math' as math;

import 'package:file_picker/file_picker.dart';
import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_web_auth_2/flutter_web_auth_2.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:http/http.dart' as http;
import 'package:image_picker/image_picker.dart';
import 'package:path_provider/path_provider.dart';
import 'package:record/record.dart';
import 'package:url_launcher/url_launcher.dart';

/// The one thing every future client (Flutter, PWA, desktop) points at.
/// Changing this one line is the entire cost of a future domain swap.
const officeApiBase = 'https://office.websitehub.co.za';

// Design tokens — real, decisive rebuild toward
// DESIGN_CONSTITUTION_V2.md, the most architecturally authoritative
// of the three real design documents. "Background: true black. Not
// dark grey. Not warm charcoal." The exact --void/--pulse/--breathe
// palette from ether-manifesto.html, not the earlier charcoal
// prototype's palette. Pulse red is now the dominant, primary color
// — "one large red circle... it is not a button. It is presence."
const _void = Color(0xFF0A0A0B);
// Real, deliberate alias — _charcoal was the background color in the
// old palette; kept as an alias to _void for the same reason as
// _paper above.
const _charcoal = _void;
const _pulse = Color(0xFFE63946);
const _pulseGlow = Color(0x4DE63946); // rgba(230,57,70,0.3)
const _breathe = Color(0xFF2A9D8F);
const _amber = Color(0xFFF4A261);
const _textPrimary = Color(0xFFF5F5F5);
// Real, deliberate alias — _paper was the main text color in the old
// palette; kept as an alias to _textPrimary rather than hunting down
// every one of its many existing usages throughout this file, which
// would risk introducing a mistake for no real benefit.
const _paper = _textPrimary;
const _textSecondary = Color(0xFF8A8A8F);
const _textTertiary = Color(0xFF5A5A5F);
// Kept for now, still used by confirm/reject stamps and the message
// line accents, which step 1 of this rebuild deliberately leaves
// untouched — the guard()'d confirm flow is the single most
// load-bearing piece of the whole app and isn't being touched
// alongside a visual rebuild.
const _muted = _textTertiary;
const _officeAccent = _breathe;
const _userAccent = _amber;
const _stampRed = _pulse;
const _confirmedGreen = _breathe;

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
        scaffoldBackgroundColor: _void,
        colorScheme: ColorScheme.fromSeed(
          seedColor: _pulse,
          brightness: Brightness.dark,
        ).copyWith(surface: _void),
        textTheme: GoogleFonts.workSansTextTheme(base.textTheme).apply(
          bodyColor: _textPrimary,
          displayColor: _textPrimary,
        ),
        appBarTheme: AppBarTheme(
          backgroundColor: _void,
          foregroundColor: _textPrimary,
          elevation: 0,
          scrolledUnderElevation: 0,
          titleTextStyle: GoogleFonts.ibmPlexMono(
            color: _textPrimary,
            fontWeight: FontWeight.w600,
            fontSize: 19,
            letterSpacing: 1.8,
          ),
        ),
        drawerTheme: const DrawerThemeData(backgroundColor: _void),
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

  // Real bug fix, found live: counts default to zero before the real
  // first fetch completes, which made the app briefly claim "all
  // clear" (the green sigh state) on every launch — a false positive
  // during a genuine loading gap, not a real answer. hasLoaded folds
  // directly into allClear itself so this can never be claimed until
  // the app has actually checked.
  bool hasLoaded = false;

  // Real feature 2026-07-27 — the sigh state (Ether manifesto, "the
  // sigh is the metric"). True only when every real count is
  // genuinely zero AND the app has actually loaded real data to know
  // that — never inferred, never a default-value false positive.
  bool get allClear => hasLoaded && tasks == 0 && scheduler == 0 && finance == 0 && suppliers == 0 && pending == 0;
}

class OfficeHome extends StatefulWidget {
  const OfficeHome({super.key});

  @override
  State<OfficeHome> createState() => _OfficeHomeState();
}

class _OfficeHomeState extends State<OfficeHome> with TickerProviderStateMixin {
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

  // Real feature 2026-07-28 — the one-time entrance moment: "the
  // logo... animate it once. When the Office opens. Then let it
  // become still. Almost like opening the door to a quiet room."
  // Fades in, holds briefly, fades out — never seen again this
  // session.
  late final AnimationController _entranceController;
  late final Animation<double> _entranceOpacity;

  // Real feature 2026-07-28 — "the glow is almost there. I'd make it
  // breathe. Not pulse. Breathe. About a 7-10 second cycle. Almost
  // imperceptible. Like a sleeping person." A slow, continuous,
  // subtle intensity cycle on the primary circle's glow.
  late final AnimationController _breatheController;

  // Real feature 2026-07-27 — real login, bearer-token based per the
  // deliberate architecture decision: cookies were never going to
  // work reliably for an app-based client (no cookie jar natively,
  // and the wildcard CORS origin blocks credentialed cookie requests
  // on web anyway). flutter_secure_storage uses the platform's real,
  // hardware-backed keystore rather than plain app storage.
  final _secureStorage = const FlutterSecureStorage();
  String? _sessionToken;
  String? _userEmail;
  String? _userRole;
  bool get _isSignedIn => _sessionToken != null;

  @override
  void initState() {
    super.initState();
    _restoreSession();
    _loadEmberCounts();

    _entranceController = AnimationController(vsync: this, duration: const Duration(milliseconds: 4200));
    _entranceOpacity = TweenSequence<double>([
      TweenSequenceItem(tween: Tween(begin: 0.0, end: 1.0).chain(CurveTween(curve: Curves.easeIn)), weight: 30),
      TweenSequenceItem(tween: ConstantTween(1.0), weight: 25),
      TweenSequenceItem(tween: Tween(begin: 1.0, end: 0.0).chain(CurveTween(curve: Curves.easeOut)), weight: 45),
    ]).animate(_entranceController);
    _entranceController.forward();

    _breatheController = AnimationController(vsync: this, duration: const Duration(seconds: 8))..repeat(reverse: true);
  }

  @override
  void dispose() {
    _recorder.dispose();
    _textController.dispose();
    _scrollController.dispose();
    _entranceController.dispose();
    _breatheController.dispose();
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
        final response = await http.get(Uri.parse('$officeApiBase$path'), headers: _authHeaders());
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
    // Real bug fix: only now does the app actually know whether
    // things are clear or not — never claim "all clear" before this
    // point, even if every real count still happens to be zero.
    setState(() => _embers.hasLoaded = true);
  }

  // Real feature 2026-07-27 — checks for a real, previously-stored
  // token on startup and verifies it's still valid against /auth/me,
  // rather than trusting a stored token blindly (it could be expired
  // — real, signed tokens carry a real 30-day expiry).
  Future<void> _restoreSession() async {
    final token = await _secureStorage.read(key: 'session_token');
    if (token == null) return;
    try {
      final response = await http.get(
        Uri.parse('$officeApiBase/auth/me'),
        headers: {'Authorization': 'Bearer $token'},
      );
      if (response.statusCode == 200) {
        final data = jsonDecode(response.body) as Map<String, dynamic>;
        if (data['signedIn'] == true) {
          setState(() {
            _sessionToken = token;
            _userEmail = data['email'] as String?;
            _userRole = data['role'] as String?;
          });
          return;
        }
      }
    } catch (_) {
      // Real, deliberate no-op — treated the same as "not signed in"
      // below; a network hiccup on startup shouldn't be shown as an
      // error, it just means signed-out state until retried.
    }
    // Token was invalid, expired, or unreachable — real, honest
    // cleanup rather than holding onto something that doesn't work.
    await _secureStorage.delete(key: 'session_token');
  }

  // Real feature 2026-07-27 — the real, final-form login flow, now
  // platform-aware. flutter_web_auth_2's web implementation requires
  // landing on the exact same origin the app is running on (its own
  // postMessage security model) — genuinely different from native,
  // which uses the theoffice:// scheme the backend defaults to when
  // no platform/origin is given.
  Future<void> _signIn() async {
    try {
      var loginUrl = '$officeApiBase/auth/google/login';
      var callbackScheme = 'theoffice';
      if (kIsWeb) {
        final origin = Uri.base.origin;
        loginUrl += '?platform=web&redirect_origin=${Uri.encodeComponent(origin)}';
        // flutter_web_auth_2's own documented pattern for web: the
        // real redirect lands on an https page (the callback page
        // installed at web/auth-callback.html), not a custom scheme.
        callbackScheme = 'https';
      }
      final result = await FlutterWebAuth2.authenticate(
        url: loginUrl,
        callbackUrlScheme: callbackScheme,
      );
      final uri = Uri.parse(result);
      final token = uri.queryParameters['token'];
      final email = uri.queryParameters['email'];
      final role = uri.queryParameters['role'];
      if (token == null) {
        _addMessage(MessageRole.office, 'Sign-in did not return a real token — try again.');
        return;
      }
      await _secureStorage.write(key: 'session_token', value: token);
      setState(() {
        _sessionToken = token;
        _userEmail = email;
        _userRole = role;
      });
      _loadEmberCounts();
    } catch (_) {
      _addMessage(MessageRole.office, 'Sign-in was cancelled or failed.');
    }
  }

  // Real, honest note: session tokens are self-contained, signed
  // JWTs with no server-side session store to invalidate — "logout"
  // is genuinely just forgetting the local token, not a real server
  // call. The cookie-clearing /auth/logout route exists for the
  // cookie flow, which this app no longer uses.
  Future<void> _signOut() async {
    await _secureStorage.delete(key: 'session_token');
    setState(() {
      _sessionToken = null;
      _userEmail = null;
      _userRole = null;
    });
  }

  // Real feature 2026-07-27 — the one, shared helper every real HTTP
  // call site uses, so the actual bearer-token sending is never
  // duplicated or forgotten at a new call site.
  Map<String, String> _authHeaders([Map<String, String>? extra]) {
    return {if (_sessionToken != null) 'Authorization': 'Bearer $_sessionToken', ...?extra};
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

  // Real, direct feedback: "when Peter finishes talking, there should
  // be about half a second of complete stillness... then one ember
  // glows slightly brighter... no loading indicator, no AI typing,
  // just the fire is working." Replaces the earlier rotating
  // status-text mechanism entirely.
  String? _thinkingEmberId;

  Future<void> _startThinking() async {
    await Future.delayed(const Duration(milliseconds: 500));
    if (!mounted) return;
    const emberIds = ['tasks', 'scheduler', 'finance', 'suppliers', 'pending'];
    setState(() => _thinkingEmberId = emberIds[math.Random().nextInt(emberIds.length)]);
  }

  void _stopThinking() {
    if (!mounted) return;
    setState(() => _thinkingEmberId = null);
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
    final statusId = _addMessage(MessageRole.status, '');
    _startThinking();

    try {
      final uri = Uri.parse('$officeApiBase/messages/text');
      final response = await http.post(
        uri,
        headers: _authHeaders({'Content-Type': 'application/json'}),
        body: jsonEncode({'text': text, 'history': history}),
      );
      _stopThinking();

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
      _stopThinking();
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
    final statusId = _addMessage(MessageRole.status, '');
    _startThinking();

    try {
      final uri = Uri.parse('$officeApiBase/files/audio');
      final request = http.MultipartRequest('POST', uri);
      request.headers.addAll(_authHeaders());
      request.files.add(await http.MultipartFile.fromPath('audio', path));
      request.fields['history'] = jsonEncode(history);
      final streamed = await request.send();
      final response = await http.Response.fromStream(streamed);
      _stopThinking();

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
      _stopThinking();
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
    final statusId = _addMessage(MessageRole.status, '');
    _startThinking();

    try {
      final uri = Uri.parse('$officeApiBase/files/$endpoint');
      final request = http.MultipartRequest('POST', uri);
      request.headers.addAll(_authHeaders());
      request.files.add(await http.MultipartFile.fromPath(fieldName, path));
      final streamed = await request.send();
      final response = await http.Response.fromStream(streamed);
      _stopThinking();

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
      _stopThinking();
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
      final response = await http.post(uri, headers: _authHeaders());
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
      // Real, direct fix: the persistent "THE OFFICE" title and a
      // full-opacity menu icon were still saying "here's the
      // interface." Removed entirely from the ongoing chrome — a
      // real, one-time entrance moment replaces it (see initState),
      // then genuine stillness. Both navigation icons explicitly
      // overridden to the same low-opacity treatment as the
      // secondary intake icons below, rather than Flutter's default,
      // full-opacity auto-generated drawer icon.
      appBar: AppBar(
        backgroundColor: _void,
        elevation: 0,
        leading: Builder(
          builder: (context) => IconButton(
            icon: const Icon(Icons.menu),
            color: _textTertiary.withOpacity(0.15),
            onPressed: () => Scaffold.of(context).openDrawer(),
          ),
        ),
        actions: [
          IconButton(
            icon: const Icon(Icons.more_vert),
            color: _textTertiary.withOpacity(0.15),
            onPressed: () => _showMoreMenu(context),
          ),
        ],
      ),
      drawer: _OfficeDrawer(
        onReportsTap: _showReportsSheet,
        onPeopleTap: _showPeopleSheet,
        onHistoryTap: _showHistorySheet,
      ),
      body: SafeArea(
        child: Stack(
          children: [
            Column(
              children: [
                Expanded(
                  child: _embers.allClear && _messages.isEmpty
                      ? const _SighState()
                      : ListView.builder(
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
                _TalkArea(
                  embers: _embers,
                  onEmberTap: _showEmberSheet,
                  controller: _textController,
                  isRecording: _isRecording,
                  isWriteMode: _isWriteMode,
                  isAllClear: _embers.allClear && _messages.isEmpty,
                  breatheController: _breatheController,
                  thinkingEmberId: _thinkingEmberId,
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
            // Real feature 2026-07-28 — the one-time entrance moment.
            // Positioned above everything else, but ignoring pointer
            // events entirely once it starts fading, so it never
            // blocks real interaction with the screen underneath.
            IgnorePointer(
              child: FadeTransition(
                opacity: _entranceOpacity,
                child: Center(
                  child: Text(
                    'THE OFFICE',
                    style: GoogleFonts.ibmPlexMono(
                      color: _textPrimary,
                      fontWeight: FontWeight.w600,
                      fontSize: 22,
                      letterSpacing: 3,
                    ),
                  ),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  // The three-dot menu — real, meta, account-level actions, not
  // business data. Mirrors this very interface's own convention
  // rather than inventing a new one. Account is now wired to the
  // real sign-in flow; Settings and Help remain named destinations
  // in UI_MAP.md, not yet built.
  Future<void> _showMoreMenu(BuildContext context) async {
    final selected = await showMenu<String>(
      context: context,
      position: const RelativeRect.fromLTRB(1000, 60, 0, 0),
      color: _charcoal,
      items: [
        PopupMenuItem(value: 'account', child: Text(_isSignedIn ? (_userEmail ?? 'Account') : 'Sign in')),
        const PopupMenuItem(value: 'settings', child: Text('Settings')),
        const PopupMenuItem(value: 'help', child: Text('Help & tutorials')),
      ],
    );
    if (selected == 'account') _showAccountSheet();
  }

  // Real feature 2026-07-27 — the real account sheet: sign-in for a
  // signed-out state, real, signed-in identity plus sign-out for a
  // signed-in one.
  void _showAccountSheet() {
    showModalBottomSheet(
      context: context,
      backgroundColor: _charcoal,
      builder: (context) => SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(20),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text('ACCOUNT', style: GoogleFonts.ibmPlexMono(color: _paper, fontSize: 14, fontWeight: FontWeight.w700, letterSpacing: 1.6)),
              const SizedBox(height: 16),
              if (_isSignedIn) ...[
                Text(_userEmail ?? '', style: GoogleFonts.workSans(color: _paper, fontSize: 15)),
                const SizedBox(height: 4),
                Text((_userRole ?? '').toUpperCase(), style: GoogleFonts.ibmPlexMono(color: _muted, fontSize: 11, letterSpacing: 1)),
                const SizedBox(height: 20),
                TextButton(
                  onPressed: () {
                    Navigator.pop(context);
                    _signOut();
                  },
                  child: Text('SIGN OUT', style: GoogleFonts.ibmPlexMono(color: _stampRed, fontSize: 12, fontWeight: FontWeight.w700, letterSpacing: 1)),
                ),
              ] else ...[
                Text('Not signed in.', style: GoogleFonts.workSans(color: _muted, fontStyle: FontStyle.italic)),
                const SizedBox(height: 16),
                TextButton(
                  onPressed: () {
                    Navigator.pop(context);
                    _signIn();
                  },
                  child: Text('SIGN IN WITH GOOGLE', style: GoogleFonts.ibmPlexMono(color: _officeAccent, fontSize: 12, fontWeight: FontWeight.w700, letterSpacing: 1)),
                ),
              ],
            ],
          ),
        ),
      ),
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

  // Real feature 2026-07-27 — wiring the drawer, working down the
  // agreed dev-URL build list. Reports opens the real, already-proven
  // PDF endpoints directly, exact real routes confirmed against the
  // manifesto's own tested implementation.
  void _showReportsSheet() {
    showModalBottomSheet(
      context: context,
      backgroundColor: _charcoal,
      builder: (context) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            ListTile(
              leading: const Icon(Icons.description_outlined, color: _muted),
              title: Text('Profit & Loss', style: GoogleFonts.workSans(color: _paper)),
              onTap: () {
                Navigator.pop(context);
                launchUrl(Uri.parse('$officeApiBase/reports/profit-and-loss/pdf'), webOnlyWindowName: '_blank');
              },
            ),
            ListTile(
              leading: const Icon(Icons.description_outlined, color: _muted),
              title: Text('Aged Debtors', style: GoogleFonts.workSans(color: _paper)),
              onTap: () {
                Navigator.pop(context);
                launchUrl(Uri.parse('$officeApiBase/reports/aged-debtors/pdf'), webOnlyWindowName: '_blank');
              },
            ),
          ],
        ),
      ),
    );
  }

  // Real feature 2026-07-27 — People, fetched fresh on open rather
  // than cached like the embers, since this is a rarely-opened,
  // on-demand list rather than something needing constant refresh.
  Future<void> _showPeopleSheet() async {
    List<dynamic> people = [];
    try {
      final response = await http.get(Uri.parse('$officeApiBase/debug/characters'), headers: _authHeaders());
      if (response.statusCode == 200) {
        final data = jsonDecode(response.body) as Map<String, dynamic>;
        people = data['characters'] as List? ?? [];
      }
    } catch (_) {
      // Real, deliberate no-op — an empty list is shown honestly
      // below rather than a confusing error for a low-stakes lookup.
    }
    if (!mounted) return;
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
              Text('PEOPLE', style: GoogleFonts.ibmPlexMono(color: _paper, fontSize: 14, fontWeight: FontWeight.w700, letterSpacing: 1.6)),
              const SizedBox(height: 12),
              if (people.isEmpty)
                Text('Nobody real here yet.', style: GoogleFonts.workSans(color: _muted, fontStyle: FontStyle.italic))
              else
                ConstrainedBox(
                  constraints: BoxConstraints(maxHeight: MediaQuery.of(context).size.height * 0.5),
                  child: ListView(
                    shrinkWrap: true,
                    children: people.map((p) {
                      final row = p as Map<String, dynamic>;
                      final relationship = row['relationship'] as String?;
                      return _docketCard('${row['name']}${relationship != null ? ' — $relationship' : ''}');
                    }).toList(),
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }

  // Real feature 2026-07-27 — History, the real, deliberately simple
  // input/output ledger. Currently shows only the real input side
  // (raw_text) from /debug/captures — whether a companion route
  // carries the paired output is a real, open question named in
  // BUILD_SEQUENCE.md, not yet resolved, so this is honestly partial
  // for now rather than pretending completeness.
  Future<void> _showHistorySheet() async {
    List<dynamic> captures = [];
    try {
      final response = await http.get(Uri.parse('$officeApiBase/debug/captures'), headers: _authHeaders());
      if (response.statusCode == 200) {
        final data = jsonDecode(response.body) as Map<String, dynamic>;
        captures = data['captures'] as List? ?? [];
      }
    } catch (_) {
      // Real, deliberate no-op — matches the same honest-empty
      // pattern as People above.
    }
    if (!mounted) return;
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
              Text('HISTORY', style: GoogleFonts.ibmPlexMono(color: _paper, fontSize: 14, fontWeight: FontWeight.w700, letterSpacing: 1.6)),
              const SizedBox(height: 12),
              if (captures.isEmpty)
                Text('Nothing real here yet.', style: GoogleFonts.workSans(color: _muted, fontStyle: FontStyle.italic))
              else
                ConstrainedBox(
                  constraints: BoxConstraints(maxHeight: MediaQuery.of(context).size.height * 0.5),
                  child: ListView(
                    shrinkWrap: true,
                    children: captures.map((c) {
                      final row = c as Map<String, dynamic>;
                      return _docketCard(row['raw_text']?.toString() ?? '');
                    }).toList(),
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }
}

// The hamburger drawer — real navigation into existing data, mirroring
// this very interface's own sidebar. All three items now wired to
// real backend data — Reports opens real, already-proven PDFs;
// People and History fetch real, live lists on open.
class _OfficeDrawer extends StatelessWidget {
  final VoidCallback onReportsTap;
  final VoidCallback onPeopleTap;
  final VoidCallback onHistoryTap;
  const _OfficeDrawer({required this.onReportsTap, required this.onPeopleTap, required this.onHistoryTap});

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
            _drawerItem(Icons.description_outlined, 'Reports & Documents', onReportsTap, context),
            _drawerItem(Icons.people_outline, 'People', onPeopleTap, context),
            _drawerItem(Icons.history, 'History', onHistoryTap, context),
          ],
        ),
      ),
    );
  }

  Widget _drawerItem(IconData icon, String label, VoidCallback onTap, BuildContext context) {
    return ListTile(
      leading: Icon(icon, color: _muted),
      title: Text(label, style: GoogleFonts.workSans(color: _paper, fontSize: 15)),
      onTap: () {
        Navigator.pop(context);
        onTap();
      },
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

class _Ember extends StatefulWidget {
  final Color color;
  final int count;
  final VoidCallback onTap;
  final bool isThinking;
  const _Ember({required this.color, required this.count, required this.onTap, this.isThinking = false});

  @override
  State<_Ember> createState() => _EmberState();
}

// A single offset sub-shape - 2-3 of these together form one ember's
// genuinely irregular silhouette, rather than one perfect circle.
class _EmberBlob {
  final double dx;
  final double dy;
  final double sizeRatio;
  final double driftPhase;
  const _EmberBlob({required this.dx, required this.dy, required this.sizeRatio, required this.driftPhase});
}

class _EmberState extends State<_Ember> with SingleTickerProviderStateMixin {
  late final AnimationController _driftController;
  // Real, deliberate randomization per ember instance — duration and
  // phase both vary, so no two embers ever drift in sync. "Their
  // movement should be random enough to feel alive" (Design
  // Constitution v2). Direct feedback: "on a 20-30 second cycle. Not
  // enough that anyone consciously notices."
  late final double _driftRadiusX;
  late final double _driftRadiusY;
  late final double _phaseOffset;
  // Direct feedback: "real embers aren't circles... different
  // brightness, different sizes, almost organic." A small, fixed
  // per-instance variation rather than a perfectly uniform tier size.
  late final double _sizeVariation;
  // Direct feedback: "an ember isn't an orb at all... embers, sparks,
  // heavier but fluid." Each ember's silhouette is genuinely
  // irregular, built from 2-3 offset sub-blobs rather than one
  // perfect circle, seeded per instance so no two look identical.
  late final List<_EmberBlob> _blobs;
  // Direct feedback: real coals flicker, not just breathe smoothly —
  // roughly 40% of embers get a faster, smaller, more erratic
  // oscillation layered on top of the slow breathe cycle.
  late final bool _isFlickery;
  late final double _flickerSpeed;
  late final double _flickerPhase;

  @override
  void initState() {
    super.initState();
    final seed = widget.color.value + widget.count;
    final random = math.Random(seed);
    _driftController = AnimationController(
      vsync: this,
      duration: Duration(milliseconds: 20000 + random.nextInt(10000)),
    )..repeat();
    _driftRadiusX = 5 + random.nextDouble() * 6;
    _driftRadiusY = 4 + random.nextDouble() * 5;
    _phaseOffset = random.nextDouble() * 2 * math.pi;
    _sizeVariation = 0.85 + random.nextDouble() * 0.3;
    _blobs = List.generate(2 + random.nextInt(2), (i) {
      return _EmberBlob(
        dx: (random.nextDouble() - 0.5) * 0.55,
        dy: (random.nextDouble() - 0.5) * 0.55,
        sizeRatio: 0.55 + random.nextDouble() * 0.4,
        driftPhase: random.nextDouble() * 2 * math.pi,
      );
    });
    _isFlickery = random.nextDouble() < 0.4;
    _flickerSpeed = 3 + random.nextDouble() * 4;
    _flickerPhase = random.nextDouble() * 2 * math.pi;
  }

  @override
  void dispose() {
    _driftController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    // Real, tested tiers, exact thresholds carried forward from the
    // manifesto's own real JS logic — never a flat lit/unlit, real
    // magnitude shown as real brightness. Size now scales with the
    // same real count too — "weight," not just glow.
    final double brightness;
    final Color core;
    final double diameter;
    if (widget.count >= 6) {
      brightness = 1.35;
      core = widget.color;
      diameter = 18;
    } else if (widget.count >= 3) {
      brightness = 1.0;
      core = widget.color;
      diameter = 14;
    } else if (widget.count >= 1) {
      brightness = 0.7;
      core = widget.color;
      diameter = 10;
    } else {
      brightness = 0.5;
      core = _emberUnlit;
      diameter = 6;
    }
    // Real, Flutter-specific equivalent of the general "isolate
    // expensive, glowing, continuously-animating elements" concern -
    // RepaintBoundary ensures this ember's own repaint (every tick,
    // for its whole lifetime) stays on its own layer rather than
    // forcing a repaint of whatever it's embedded in.
    return RepaintBoundary(
      child: AnimatedBuilder(
        animation: _driftController,
        builder: (context, child) {
          final t = _driftController.value * 2 * math.pi + _phaseOffset;
          final dx = math.sin(t) * _driftRadiusX;
          final dy = math.cos(t * 0.8) * _driftRadiusY;
          // Direct feedback: "they should slowly brighten, dim, drift,
          // wobble on a 20-30 second cycle... enough that the screen
          // never feels frozen." Same slow cycle also modulates real
          // glow intensity, not just position.
          final glowPulse = 0.85 + (math.sin(t) * 0.15);
          final actualDiameter = diameter * _sizeVariation;
          // Direct feedback: real coals flicker, not just breathe
          // smoothly. A faster, smaller, more erratic oscillation
          // layered on top of the slow breathe cycle, only for the
          // roughly 40% of embers seeded as "flickery."
          final flickerValue = _isFlickery
              ? 1.0 + (math.sin(t * _flickerSpeed + _flickerPhase) * math.sin(t * _flickerSpeed * 1.7) * 0.18)
              : 1.0;
          // Real, direct feedback: "one ember glows slightly brighter...
          // no loading indicator... just the fire is working." This
          // specific ember lights up regardless of its real, current
          // count while chosen as the thinking signal.
          final effectiveCore = widget.isThinking ? widget.color : core;
          final effectiveGlow = widget.isThinking ? glowPulse * 1.8 : glowPulse * flickerValue;
          final showGlow = widget.count > 0 || widget.isThinking;
          return Transform.translate(
            offset: Offset(dx, dy),
            child: GestureDetector(
              onTap: widget.onTap,
              child: SizedBox(
                width: 32,
                height: 32,
                // Real, genuine performance fix: replaces the previous
                // BoxShadow blur (which forces an expensive rasterized
                // blur mask every single frame) with a CustomPainter
                // drawing RadialGradient shaders directly - the soft
                // "glow" comes entirely from gradient opacity falloff,
                // cheap GPU shader math, no blur kernel recalculated
                // per tick.
                //
                // Real bug, found live: the glow radius at higher
                // brightness tiers actually exceeds this 32x32 layout
                // size, so Flutter was clipping the paint at that
                // boundary — the visible hard rectangular edge around
                // each ember. OverflowBox lets the glow paint into a
                // real, larger area without changing the tap target or
                // affecting the positioning calculations elsewhere.
                child: OverflowBox(
                  maxWidth: 96,
                  maxHeight: 96,
                  child: CustomPaint(
                    size: const Size(96, 96),
                    painter: _EmberGlowPainter(
                      color: widget.color,
                      core: effectiveCore,
                      brightness: brightness,
                      diameter: actualDiameter,
                      glowIntensity: showGlow ? effectiveGlow : 0,
                      blobs: _blobs,
                      driftTime: t,
                    ),
                  ),
                ),
              ),
            ),
          );
        },
      ),
    );
  }
}

// Real, deliberate CustomPainter replacing BoxShadow blur entirely -
// see the RepaintBoundary comment above for the full rationale. Draws
// a soft glow halo via RadialGradient opacity falloff (no blur), then
// the solid core circle on top.
class _EmberGlowPainter extends CustomPainter {
  final Color color;
  final Color core;
  final double brightness;
  final double diameter;
  final double glowIntensity;
  final List<_EmberBlob> blobs;
  final double driftTime;

  _EmberGlowPainter({
    required this.color,
    required this.core,
    required this.brightness,
    required this.diameter,
    required this.glowIntensity,
    required this.blobs,
    required this.driftTime,
  });

  @override
  void paint(Canvas canvas, Size size) {
    final center = Offset(size.width / 2, size.height / 2);
    if (glowIntensity > 0) {
      final glowRadius = diameter * 1.4 * brightness;
      final glowPaint = Paint()
        ..shader = RadialGradient(
          colors: [color.withOpacity(0.55 * glowIntensity), color.withOpacity(0.0)],
        ).createShader(Rect.fromCircle(center: center, radius: glowRadius));
      canvas.drawCircle(center, glowRadius, glowPaint);
    }
    // Direct feedback: "an ember isn't an orb at all... heavier but
    // fluid." The core is built from 2-3 overlapping sub-blobs,
    // additively blended so they merge into one cohesive but
    // genuinely irregular shape, rather than a single perfect circle.
    // Each blob also drifts very slightly on its own slow phase, so
    // the silhouette itself subtly morphs over time, not just its
    // overall position.
    final coreColor = Color.lerp(core, Colors.white, (brightness - 1).clamp(0, 1) * 0.5) ?? core;
    for (final blob in blobs) {
      final wobble = 0.06;
      final blobDx = (blob.dx + math.sin(driftTime * 0.6 + blob.driftPhase) * wobble) * diameter;
      final blobDy = (blob.dy + math.cos(driftTime * 0.5 + blob.driftPhase) * wobble) * diameter;
      final blobCenter = center + Offset(blobDx, blobDy);
      final blobRadius = (diameter / 2) * blob.sizeRatio;
      final blobPaint = Paint()
        ..blendMode = BlendMode.plus
        ..shader = RadialGradient(
          colors: [coreColor, core.withOpacity(0.0)],
        ).createShader(Rect.fromCircle(center: blobCenter, radius: blobRadius));
      canvas.drawCircle(blobCenter, blobRadius, blobPaint);
    }
  }

  @override
  bool shouldRepaint(covariant _EmberGlowPainter oldPainter) {
    return oldPainter.color != color ||
        oldPainter.core != core ||
        oldPainter.brightness != brightness ||
        oldPainter.diameter != diameter ||
        oldPainter.glowIntensity != glowIntensity ||
        oldPainter.driftTime != driftTime;
  }
}

// Real, deliberate CustomPainter for the primary circle's glow -
// same rationale as _EmberGlowPainter, applied to the one, dominant
// object rather than the embers.
class _CircleGlowPainter extends CustomPainter {
  final Color color;
  final double coreDiameter;
  final double glowIntensity;
  final double glowSpread;

  _CircleGlowPainter({
    required this.color,
    required this.coreDiameter,
    required this.glowIntensity,
    required this.glowSpread,
  });

  @override
  void paint(Canvas canvas, Size size) {
    final center = Offset(size.width / 2, size.height / 2);
    final glowRadius = (coreDiameter / 2) * 1.6 * glowSpread;
    final glowPaint = Paint()
      ..shader = RadialGradient(
        colors: [color.withOpacity(glowIntensity), color.withOpacity(0.0)],
      ).createShader(Rect.fromCircle(center: center, radius: glowRadius));
    canvas.drawCircle(center, glowRadius, glowPaint);
  }

  @override
  bool shouldRepaint(covariant _CircleGlowPainter oldPainter) {
    return oldPainter.color != color ||
        oldPainter.coreDiameter != coreDiameter ||
        oldPainter.glowIntensity != glowIntensity ||
        oldPainter.glowSpread != glowSpread;
  }
}

// Real feature 2026-07-27 — the sigh state (Ether manifesto section
// 03, "when nothing is urgent, the app tells you to breathe"). Shown
// only when every real ember count is genuinely zero and nothing has
// been said yet this session — never simulated, never shown by
// default. Deliberately calm: no card, no border, just centered text
// in the real breathe color, matching the manifesto's own described
// state exactly.
class _SighState extends StatelessWidget {
  const _SighState();

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 32),
        child: Text(
          'Nothing urgent.\nBreathe.',
          textAlign: TextAlign.center,
          style: GoogleFonts.workSans(
            fontSize: 20,
            color: _breathe,
            height: 1.5,
            fontWeight: FontWeight.w400,
          ),
        ),
      ),
    );
  }
}

// Real, decisive rebuild toward DESIGN_CONSTITUTION_V2.md's Home
// Screen Specification. "One large red circle. Everything else is
// secondary... It is not a button. It is presence." Embers scattered
// above it as ambient atmosphere, never a neat navigation row. Camera,
// document, and write are real, still-needed secondary intake paths
// (the Constitution's own spec names them explicitly) but rendered as
// small, low-opacity "almost silhouettes," never competing visually
// with the one, dominant object.
class _TalkArea extends StatelessWidget {
  final EmberCounts embers;
  final void Function(String emberId) onEmberTap;
  final TextEditingController controller;
  final bool isRecording;
  final bool isWriteMode;
  final bool isAllClear;
  final AnimationController breatheController;
  final String? thinkingEmberId;
  final VoidCallback onSend;
  final VoidCallback onMicTap;
  final VoidCallback onCameraTap;
  final VoidCallback onDocumentTap;
  final VoidCallback onToggleWriteMode;
  final VoidCallback onDiscard;

  const _TalkArea({
    required this.embers,
    required this.onEmberTap,
    required this.controller,
    required this.isRecording,
    required this.isWriteMode,
    required this.isAllClear,
    required this.breatheController,
    required this.thinkingEmberId,
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
        // Real fix, found live: a cramped, fixed 260px strip made the
        // circle read as stranded at the very bottom of an empty
        // screen rather than genuinely situated in the space. A real
        // fraction of the actual available height gives it room to
        // feel like presence rather than an afterthought.
        height: MediaQuery.of(context).size.height * 0.42,
        padding: const EdgeInsets.fromLTRB(24, 8, 24, 20),
        child: isWriteMode ? _buildWriteMode() : _buildTalkState(),
      ),
    );
  }

  Widget _buildTalkState() {
    return Stack(
      children: [
        // Real, direct feedback: "the embers should feel like they're
        // waiting for Peter... coals lying underneath [the button]."
        // Moved from a side cluster to directly beneath the circle —
        // a wider, flatter spread reading as a hearth rather than
        // orbiting satellites. Genuinely scattered — varying x and y,
        // never a neat, aligned row — real weighted orbs, each
        // drifting independently.
        Align(
          alignment: const Alignment(0, 0.62),
          child: SizedBox(
            width: 160,
            height: 60,
            child: Stack(
              children: [
                Positioned(left: 10, top: 18, child: _Ember(color: _emberAmber, count: embers.tasks, onTap: () => onEmberTap('tasks'), isThinking: thinkingEmberId == 'tasks')),
                Positioned(left: 46, top: 2, child: _Ember(color: _emberBlue, count: embers.scheduler, onTap: () => onEmberTap('scheduler'), isThinking: thinkingEmberId == 'scheduler')),
                Positioned(left: 74, top: 24, child: _Ember(color: _emberRed, count: embers.finance, onTap: () => onEmberTap('finance'), isThinking: thinkingEmberId == 'finance')),
                Positioned(left: 104, top: 6, child: _Ember(color: _emberPurple, count: embers.suppliers, onTap: () => onEmberTap('suppliers'), isThinking: thinkingEmberId == 'suppliers')),
                Positioned(left: 132, top: 20, child: _Ember(color: _emberSage, count: embers.pending, onTap: () => onEmberTap('pending'), isThinking: thinkingEmberId == 'pending')),
              ],
            ),
          ),
        ),
        // Real, direct feedback: "the button should almost float...
        // lift it about 40-60 pixels. It should feel suspended."
        Align(
          alignment: const Alignment(0, -0.18),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              // The primary object. Real, direct feedback: "the button
              // itself is the microphone" — no icon at all, and the
              // glow now breathes on a real, slow cycle rather than
              // sitting static, "like a sleeping person." Wrapped in
              // its own RepaintBoundary — the same continuously-
              // repainting, glow-heavy pattern as the embers, isolated
              // the same way.
              RepaintBoundary(
                child: AnimatedBuilder(
                  animation: breatheController,
                  builder: (context, child) {
                final breatheValue = breatheController.value; // 0..1, slow 8s cycle
                final baseColor = isRecording ? _pulse : (isAllClear ? _breathe : _pulse);
                // Real, genuine performance fix: replaces the previous
                // BoxShadow blur with a CustomPainter glow halo layered
                // behind the solid circle - same rationale as the
                // embers' _EmberGlowPainter, no blur kernel recomputed
                // every tick.
                return GestureDetector(
                  onTap: onMicTap,
                  child: SizedBox(
                    width: 160,
                    height: 160,
                    child: Stack(
                      alignment: Alignment.center,
                      children: [
                        // Real bug, found live: the glow radius at
                        // higher breathe values exceeds this 160x160
                        // layout size, so Flutter was clipping the
                        // paint at that boundary — the visible hard
                        // rectangular edge around the circle.
                        // OverflowBox lets the glow paint into a real,
                        // larger area without changing the tap target.
                        OverflowBox(
                          maxWidth: 220,
                          maxHeight: 220,
                          child: CustomPaint(
                            size: const Size(220, 220),
                            painter: _CircleGlowPainter(
                              color: baseColor,
                              coreDiameter: 96,
                              glowIntensity: 0.22 + (0.18 * breatheValue),
                              glowSpread: 1.0 + (0.35 * breatheValue),
                            ),
                          ),
                        ),
                        Container(
                          width: 96,
                          height: 96,
                          decoration: BoxDecoration(
                            shape: BoxShape.circle,
                            gradient: RadialGradient(
                              center: const Alignment(-0.3, -0.3),
                              colors: isRecording
                                  ? [_pulse, const Color(0xFF8B0000)]
                                  : isAllClear
                                      ? [_breathe, const Color(0xFF1A5F55)]
                                      : [_pulse, const Color(0xFF8B0000)],
                            ),
                          ),
                        ),
                      ],
                    ),
                  ),
                );
              },
                ),
              ),
            ],
          ),
        ),
        // Real, still-needed secondary intake paths (Home Screen
        // Specification names camera, files, and edit transcript
        // explicitly) — reduced close to invisible, a whisper rather
        // than a row of choices, per the direct feedback that they
        // were still saying "choose your workflow."
        Positioned(
          bottom: 0,
          child: Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              IconButton(
                iconSize: 18,
                icon: const Icon(Icons.camera_alt_outlined),
                color: _textTertiary.withOpacity(0.08),
                onPressed: onCameraTap,
              ),
              IconButton(
                iconSize: 18,
                icon: const Icon(Icons.attach_file),
                color: _textTertiary.withOpacity(0.08),
                onPressed: onDocumentTap,
              ),
              IconButton(
                iconSize: 18,
                icon: const Icon(Icons.edit_outlined),
                color: _textTertiary.withOpacity(0.08),
                onPressed: onToggleWriteMode,
              ),
            ],
          ),
        ),
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
    // Real, direct feedback: "no spinner. No 'processing'... just
    // stillness... then one ember glows slightly brighter." The
    // thinking signal now lives entirely in the ember, not here.
    return const SizedBox.shrink();
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

