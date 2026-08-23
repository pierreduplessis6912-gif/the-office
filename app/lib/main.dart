import 'dart:async';
import 'dart:convert';
import 'dart:math' as math;
import 'dart:ui' as ui;

import 'package:file_picker/file_picker.dart';
import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:flutter/material.dart';
import 'package:flutter_animate/flutter_animate.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_web_auth_2/flutter_web_auth_2.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:http/http.dart' as http;
import 'package:image_picker/image_picker.dart';
import 'package:speech_to_text/speech_recognition_result.dart';
import 'package:speech_to_text/speech_to_text.dart' as stt;
import 'package:url_launcher/url_launcher.dart';

import 'runtime/office_clock.dart';
import 'runtime/office_room.dart';
import 'runtime/office_state.dart';
import 'runtime/word_field.dart';

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
  // Real feature 2026-08-06 — replaces the old record-audio-then-
  // upload-then-server-transcribe pipeline entirely. Android does not
  // support recording raw audio while on-device speech recognition is
  // active at the same time (confirmed against the plugin's own
  // documentation, not assumed) — so this is the actual, authoritative
  // transcript now, the same as typed text, not a preview layered on
  // top of a separate audio upload.
  final _speech = stt.SpeechToText();
  String _lastPartialTranscript = '';
  bool _finalizedThisUtterance = false;
  final _textController = TextEditingController();
  final _scrollController = ScrollController();
  final _imagePicker = ImagePicker();

  // The Office Runtime - real, foundational pieces per
  // OFFICE_RUNTIME_V1.md. _officeState is the single source of truth
  // for what the app is doing; _clock is the single, shared timing
  // source real systems will migrate onto. Neither replaces existing
  // behavior yet on its own - this is the first, bounded wiring step,
  // not the full migration.
  final _officeState = OfficeStateMachine();
  late final OfficeClock _clock;

  // Phase 1 of the Word Field System (see runtime/word_field.dart) —
  // built against _officeState.events, the real, first thing to
  // consume it. Doesn't replace _messages/the ledger below; a purely
  // additive animation layered on top of it.
  late final WordFieldController _wordField;

  bool _isRecording = false;
  // Real orb rebuild, Stage 0, 2026-08-07 — off by default. The
  // proven Container orb stays the real experience; this only shows
  // when explicitly toggled from the more-menu, purely to verify the
  // shader pipeline on the real device before Stage 1 begins.
  // Real orb rebuild, Stage 1, 2026-08-07 — the real material, still
  // off by default. Loaded once at app level (not per-widget-mount)
  // since it's a real, shared resource the orb needs for the whole
  // session, not a one-off test. Null until _loadStage1Shader()
  // finishes; _TalkArea falls back to the proven old orb whenever
  // it's null, toggle or not.
  ui.FragmentShader? _stage1Shader;
  bool _useShaderOrb = true;
  // The embers, rebuilt, 2026-08-08 — same feature-flag discipline,
  // one shared compiled program (five embers each derive their own
  // independent shader instance from it via .fragmentShader(), rather
  // than each loading and compiling the asset separately).
  ui.FragmentProgram? _emberTearProgram;
  bool _useTearEmbers = false;
  bool _isWriteMode = false;
  int _idCounter = 0;

  // Real feature 2026-07-26 — empty by default, no hardcoded seed
  // message. "Empty screen is relief" (Constitution Principle 25) —
  // the app should start genuinely empty, not with a pre-written
  // greeting standing in for it.
  final List<ChatMessage> _messages = [];
  // The void stays a void — at most one office message is ever
  // visible at a time, via _ActiveResponse below. _messages itself
  // keeps accumulating everything, unseen, purely as real
  // conversational memory for _recentHistory().
  String? _activeMessageId;

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
  // Runtime migration: the orb's breathe cycle no longer drives its
  // own, independent AnimationController - it reads from the shared
  // _clock instead, per OFFICE_RUNTIME_V1.md's "existing systems
  // migrated onto that foundation."

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

    _clock = OfficeClock(vsync: this)..start();
    _wordField = WordFieldController(events: _officeState.events);
    _loadStage1Shader();
    _loadEmberTearShader();

    _entranceController = AnimationController(vsync: this, duration: const Duration(milliseconds: 4200));
    _entranceOpacity = TweenSequence<double>([
      TweenSequenceItem(tween: Tween(begin: 0.0, end: 1.0).chain(CurveTween(curve: Curves.easeIn)), weight: 30),
      TweenSequenceItem(tween: ConstantTween(1.0), weight: 25),
      TweenSequenceItem(tween: Tween(begin: 1.0, end: 0.0).chain(CurveTween(curve: Curves.easeOut)), weight: 45),
    ]).animate(_entranceController);
    _entranceController.forward();

    // Real migration: the orb's breathe cycle now reads _clock.elapsedSeconds
    // directly (see _TalkArea below) rather than driving its own,
    // independent AnimationController here.
  }

  @override
  void dispose() {
    _speech.stop();
    _textController.dispose();
    _scrollController.dispose();
    _entranceController.dispose();
    _clock.dispose();
    _officeState.dispose();
    _wordField.dispose();
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
  // Real orb rebuild, Stage 1, 2026-08-07 — loads once at startup.
  // Deliberately does not touch _useShaderOrb here; the toggle stays
  // false until explicitly flipped from the more-menu, same
  // feature-flag discipline as Stage 0.
  Future<void> _loadStage1Shader() async {
    try {
      final program = await ui.FragmentProgram.fromAsset('shaders/stage1_orb.frag');
      if (!mounted) return;
      setState(() => _stage1Shader = program.fragmentShader());
    } catch (e, stack) {
      debugPrint('Stage 1 shader load failed: $e\n$stack');
    }
  }

  // The embers, rebuilt, 2026-08-08 — loads the compiled program
  // once; each _EmberTear instance calls .fragmentShader() on this
  // same program to get its own independent uniform state, rather
  // than five separate asset loads and compiles.
  Future<void> _loadEmberTearShader() async {
    try {
      final program = await ui.FragmentProgram.fromAsset('shaders/ember_tear.frag');
      if (!mounted) return;
      setState(() => _emberTearProgram = program);
    } catch (e, stack) {
      debugPrint('Ember tear shader load failed: $e\n$stack');
    }
  }

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
    // Real state machine wiring, matching _updateMessage below - a
    // real office message just appeared here too, not only via the
    // status-placeholder flow.
    if (role == MessageRole.office) {
      _officeState.transitionTo(OfficeState.responding);
      _officeState.emit(ResponseReceived(text));
      _officeState.transitionTo(OfficeState.idle);
      // Real bug found on-device 2026-08-06: the response used to
      // activate immediately, independent of whatever WordField was
      // still doing — when the backend answered fast, the still-
      // dissolving input words visually collided with the answer
      // crystallizing in on top of them. Clearing here interrupts
      // them cleanly the instant the answer is ready, with one short,
      // deliberate beat before the answer appears — not the words'
      // full natural ~3-4s cycle, which would just add felt latency
      // for no reason.
      _wordField.clear();
      Timer(const Duration(milliseconds: 220), () {
        if (mounted) setState(() => _activeMessageId = id);
      });
    }
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
    // Real state machine wiring: every flow's actual response (success
    // or error text) passes through here, whichever of the three
    // real flows (text/voice/upload) produced it - the one, real
    // place to transition Responding rather than duplicating this at
    // six separate call sites. Transitions straight back to Idle,
    // since there's no real, ongoing "responding" animation yet to
    // occupy that state over time - honest about what's actually
    // happening rather than lingering in an unused state.
    if (role == MessageRole.office) {
      _officeState.transitionTo(OfficeState.responding);
      _officeState.emit(ResponseReceived(text));
      _officeState.transitionTo(OfficeState.idle);
      // Same real fix as _addMessage above — interrupt any still-
      // dissolving input words the instant the real answer is ready,
      // rather than letting them run their full course and collide
      // with it. This is the actual call site the real voice flow
      // hits, so this is the one that mattered for the reported bug.
      _wordField.clear();
      Timer(const Duration(milliseconds: 220), () {
        if (mounted) setState(() => _activeMessageId = id);
      });
    }
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
    final chosen = emberIds[math.Random().nextInt(emberIds.length)];
    setState(() => _thinkingEmberId = chosen);
    _officeState.transitionTo(OfficeState.thinking);
    _officeState.emit(EmberThinkingChanged(chosen));
  }

  void _stopThinking() {
    if (!mounted) return;
    setState(() => _thinkingEmberId = null);
    _officeState.transitionTo(OfficeState.idle);
    _officeState.emit(const EmberThinkingChanged(null));
  }

  // Real, bounded milestone: "tap an Ember, the Orb visibly knows
  // which Ember was tapped and reacts to it." Deliberately just
  // Ember → Orb - no room/route involvement at all. _ignitionEmberId/
  // _ignitionAtSeconds drive both the tapped ember's own brief
  // brighten and the orb's shader-side reaction; _ignitionSeq exists
  // purely to give FilamentOrb's didUpdateWidget a real, reliable
  // change to detect (the color or timestamp alone could coincide
  // with a prior value).
  String? _ignitionEmberId;
  double _ignitionAtSeconds = -1000;
  int _ignitionSeq = 0;

  static const _emberColors = {
    'tasks': _emberAmber,
    'scheduler': _emberBlue,
    'finance': _emberRed,
    'suppliers': _emberPurple,
    'pending': _emberSage,
  };

  // Real, doorway-mechanism support for Finance's new ERP-mode room:
  // attached to both the _EmberTear and _Ember finance instances below
  // (only one is ever actually mounted at a time, per the
  // useTearEmbers toggle) so its real, current screen position can be
  // looked up at tap time regardless of which is active - the same
  // real origin mechanism already proven for People.
  final GlobalKey _financeEmberKey = GlobalKey();

  Offset? _financeEmberOrigin() {
    final box = _financeEmberKey.currentContext?.findRenderObject() as RenderBox?;
    if (box == null || !box.attached) return null;
    final topLeft = box.localToGlobal(Offset.zero);
    return topLeft + Offset(box.size.width / 2, box.size.height / 2);
  }

  void _reactToEmberTap(String emberId) {
    setState(() {
      _ignitionEmberId = emberId;
      _ignitionAtSeconds = _clock.elapsedSeconds;
      _ignitionSeq++;
    });
  }

  // Real, eased decay (not linear) from the shared clock - 0 the
  // instant it's tapped's sibling, 1 for a brief moment, then a
  // natural ease back down. Matches the shader's own quick-rise,
  // slower-decay curve so the ember and orb settle together.
  double _tapPulseFor(String emberId) {
    if (_ignitionEmberId != emberId) return 0.0;
    final dt = _clock.elapsedSeconds - _ignitionAtSeconds;
    if (dt < 0 || dt > 0.75) return 0.0;
    final rise = Curves.easeOut.transform((dt / 0.15).clamp(0.0, 1.0));
    final decay = 1.0 - Curves.easeIn.transform(((dt - 0.15) / 0.6).clamp(0.0, 1.0));
    return (rise * decay).clamp(0.0, 1.0);
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
        await _speech.stop();
        setState(() => _isRecording = false);
        _officeState.transitionTo(OfficeState.idle);
        // Real robustness, not just the happy path: send whatever was
        // actually heard the moment Peter explicitly taps to stop,
        // rather than depending entirely on the plugin's own stop()
        // call reliably delivering one more onResult callback first.
        // _finalizedThisUtterance still guards against a genuine
        // double-send if that callback does also arrive.
        if (!_finalizedThisUtterance && _lastPartialTranscript.trim().isNotEmpty) {
          _finalizedThisUtterance = true;
          _sendRecognizedText(_lastPartialTranscript.trim());
        }
        return;
      }

      // initialize() only needs to run once per real session per the
      // plugin's own docs, and repeat calls are safe no-ops — calling
      // it every tap avoids needing a second piece of state just to
      // track whether it already ran once this session.
      final available = await _speech.initialize(
        onStatus: _onSpeechStatus,
        onError: _onSpeechError,
      );
      if (!available) {
        _addMessage(MessageRole.office, 'Speech recognition permission denied or unavailable.');
        return;
      }

      _lastPartialTranscript = '';
      _finalizedThisUtterance = false;
      _wordField.clear();
      setState(() => _isRecording = true);
      _officeState.transitionTo(OfficeState.listening);
      await _speech.listen(
        onResult: _onSpeechResult,
        listenFor: const Duration(seconds: 30),
        pauseFor: const Duration(seconds: 5),
      );
    } catch (e, stack) {
      // Surface the real error instead of failing silently — this is
      // a diagnostic addition specifically to find out what's actually
      // breaking on web, not a permanent behavior.
      setState(() => _isRecording = false);
      _officeState.transitionTo(OfficeState.idle);
      _addMessage(MessageRole.office, 'Mic error: $e');
      debugPrint('Mic error: $e\n$stack');
    }
  }

  // Real feature 2026-08-06 — words reach the void the instant the
  // on-device recognizer produces them, not after a full record-then-
  // upload-then-transcribe round trip. Only the delta since the last
  // callback gets emitted as a new WordSpoken event, so each new word
  // gets its own real appear-and-dissolve cycle as it's actually
  // recognized, rather than re-spawning the whole growing sentence
  // from scratch on every callback.
  void _onSpeechResult(SpeechRecognitionResult result) {
    final full = result.recognizedWords;
    if (full.isNotEmpty && full != _lastPartialTranscript) {
      if (full.length > _lastPartialTranscript.length && full.startsWith(_lastPartialTranscript)) {
        final delta = full.substring(_lastPartialTranscript.length).trim();
        if (delta.isNotEmpty) _officeState.emit(WordSpoken(delta));
      } else {
        // The recognizer revised an earlier guess rather than simply
        // extending it — real and common with live STT. Simplest
        // honest response: clear and show the current best guess
        // fresh, rather than trying to diff a changed prefix.
        _wordField.clear();
        _officeState.emit(WordSpoken(full));
      }
      _lastPartialTranscript = full;
    }

    if (result.finalResult && !_finalizedThisUtterance && full.trim().isNotEmpty) {
      _finalizedThisUtterance = true;
      setState(() => _isRecording = false);
      _officeState.transitionTo(OfficeState.idle);
      _sendRecognizedText(full.trim());
    }
  }

  void _onSpeechStatus(String status) {
    // Real fix for a real gap: Android's own short pause timeout can
    // end a listen session with no explicit second tap and no final
    // result at all (genuine silence, or speech too quiet to catch) —
    // without this, _isRecording would stay stuck true and the mic
    // would look permanently "on" with nothing to show for it.
    if ((status == 'done' || status == 'notListening') && _isRecording) {
      setState(() => _isRecording = false);
      _officeState.transitionTo(OfficeState.idle);
    }
  }

  void _onSpeechError(dynamic error) {
    setState(() => _isRecording = false);
    _officeState.transitionTo(OfficeState.idle);
    debugPrint('Speech recognition error: $error');
  }

  // Real feature 2026-08-06 — the actual real answer, mirroring
  // _sendText() exactly, since a finalized on-device transcript is now
  // authoritative the same way typed text already is — not a preview
  // waiting on a separate server-side transcription step that no
  // longer exists in this flow.
  Future<void> _sendRecognizedText(String text) async {
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
    // Real state machine wiring: a real, guarded action genuinely in
    // flight - Rule from OFFICE_RUNTIME_V1.md's own state list.
    _officeState.transitionTo(OfficeState.executing);

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
    _officeState.transitionTo(OfficeState.idle);
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
        onReportsTap: (_) => _showReportsSheet(),
        onPeopleTap: _showPeopleSheet,
        onHistoryTap: (_) => _showHistorySheet(),
      ),
      body: SafeArea(
        child: Stack(
          children: [
            // The void itself, now alive - see VoidLake. Painted
            // first, beneath everything else.
            const Positioned.fill(child: VoidLake()),
            // Real feature 2026-07-28 — the decorative, wide-field
            // spark layer from the reference image. Deliberately
            // separate from the 5 real, functional embers: purely
            // ambient, non-interactive, not tied to any real data —
            // atmosphere, not information.
            Positioned.fill(child: _AmbientSparkField(clock: _clock)),
            Column(
              children: [
                Expanded(
                  child: _embers.allClear && _messages.isEmpty
                      ? const _SighState()
                      : _messages.isEmpty
                          ? _Greeting(userEmail: _userEmail)
                          // The void stays a void — no permanent ledger.
                          // _messages keeps accumulating underneath
                          // (real conversational context, e.g.
                          // _recentHistory() for pronoun resolution,
                          // and Constitution Principle 3 doesn't apply
                          // here anyway since the real capture already
                          // lives server-side). But nothing renders as
                          // a scrolling list of bubbles anymore. At
                          // most one office response is ever visible,
                          // and even that one dissolves once read.
                          : Padding(
                              padding: const EdgeInsets.symmetric(horizontal: 0, vertical: 8),
                              child: _ActiveResponse(
                                message: _activeMessageId == null
                                    ? null
                                    : _messages.firstWhere(
                                        (m) => m.id == _activeMessageId,
                                        orElse: () => _messages.last,
                                      ),
                                onConfirm: (itemId) => _resolvePendingItem(_activeMessageId!, itemId, true),
                                onReject: (itemId) => _resolvePendingItem(_activeMessageId!, itemId, false),
                                onDismissed: () {
                                  if (mounted) setState(() => _activeMessageId = null);
                                },
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
                  clock: _clock,
                  thinkingEmberId: _thinkingEmberId,
                  tapPulseFor: _tapPulseFor,
                  ignitionSeq: _ignitionSeq,
                  reactColor: _ignitionEmberId != null ? _emberColors[_ignitionEmberId] : null,
                  useShaderOrb: _useShaderOrb,
                  stage1Shader: _stage1Shader,
                  useTearEmbers: _useTearEmbers,
                  emberTearProgram: _emberTearProgram,
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
            // Phase 1 of the Word Field System — real transcript words
            // appear, drift, and dissolve in the upper band, per Rule 3
            // and the Speech Visualisation spec. Painted AFTER Column
            // so it renders on top of the ledger, not underneath it —
            // real bug found on-device 2026-08-06: it originally sat
            // before Column in this Stack, so the permanent ledger
            // (which fills with the same content almost simultaneously)
            // completely buried it for its whole lifetime. IgnorePointer
            // inside WordField means it never blocks real interaction
            // with the ledger or talk area beneath it.
            //
            // Additive only, still: the ledger below still shows the
            // same transcript permanently at the same time — Rule 3's
            // larger "no permanent ledger at all" question is
            // deliberately not decided in this pass.
            Positioned.fill(child: WordField(controller: _wordField, clock: _clock)),
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
        // Real, temporary, 2026-08-07 — Stage 1 of the orb rebuild.
        // Stage 0's own toggle is gone now that it's confirmed and
        // superseded. This one swaps the real orb itself in place —
        // same feature-flag discipline, higher stakes. Remove once
        // Stage 1 is accepted and Stage 2 begins.
        PopupMenuItem(
          value: 'shader_orb',
          child: Text(_useShaderOrb ? 'Use old orb' : 'Use shader orb (Stage 1)'),
        ),
        // Real, temporary, 2026-08-08 — the embers rebuilt as tears
        // in the void rather than blob clusters. Remove once accepted.
        PopupMenuItem(
          value: 'tear_embers',
          child: Text(_useTearEmbers ? 'Use old embers' : 'Use tear embers'),
        ),
      ],
    );
    if (selected == 'account') _showAccountSheet();
    if (selected == 'shader_orb') setState(() => _useShaderOrb = !_useShaderOrb);
    if (selected == 'tear_embers') setState(() => _useTearEmbers = !_useTearEmbers);
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
    // Real, bounded milestone: "the Orb visibly knows which Ember was
    // tapped and reacts to it." A real, additional side-effect only -
    // everything below this line is the exact, existing, untouched
    // behavior.
    _reactToEmberTap(emberId);

    // Real, first ERP-mode module. Finance now opens the new, real
    // room (search + flat, blended, honest list) instead of the old
    // showModalBottomSheet - every other ember's behavior stays
    // exactly as it was until it has a real room of its own.
    if (emberId == 'finance') {
      final origin = _financeEmberOrigin();
      if (origin != null) {
        _showFinanceRoom(origin);
        return;
      }
      // Real, honest fallback - if the real position genuinely can't
      // be found (e.g. mid-layout-change), fall through to the old
      // behavior rather than silently do nothing.
    }

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

  // Real, first ERP-mode module, per ERP_MODE_ARCHITECTURE.md. Same
  // proven doorway - ignition at the real, tapped origin, then the
  // room grows from that same point and color - as People. Content
  // is a real, separate StatefulWidget since it needs its own local
  // state for search-as-you-type, not something the inline builder
  // callback can hold.
  Future<void> _showFinanceRoom(Offset origin) async {
    await _igniteEmber(origin, _emberRed);
    if (!mounted) return;
    await showOfficeRoom(
      context: context,
      officeState: _officeState,
      origin: origin,
      accentColor: _emberRed,
      builder: (context) => _FinanceRoomContent(authHeaders: _authHeaders()),
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
  Future<void> _showPeopleSheet(Offset origin) async {
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
    // Real, direct feedback: "when I tap an ember, does my brain
    // perceive that ember as the thing opening the room?" The
    // ignition plays first, at the same real, tapped origin - then
    // the room's own, existing, unmodified transform takes over from
    // the same point and colour, so the two read as one continuous
    // event rather than tap → animation → dialog → animation.
    await _igniteEmber(origin, _emberAmber);
    if (!mounted) return;
    // Real first room, per Rule 8 - "the relevant world quietly
    // appears," materializing rather than sliding up from an edge.
    // Real, direct feedback: "the room should be born from the
    // ember" - now genuinely grows from the real, tapped origin
    // rather than always the screen's center.
    //
    // Real, direct feedback, found live: "it looks pretty much just
    // like a card." Honest, and correct - a bordered, rounded-corner
    // box centered on a darkened backdrop is exactly a dialog, no
    // matter how it entered. Rebuilt as a genuine full-screen room -
    // no border, no card fill, the same void-black background as the
    // main Office, so it reads as a real continuation of the same
    // world rather than a surface floating on top of it.
    await showOfficeRoom(
      context: context,
      officeState: _officeState,
      origin: origin,
      accentColor: _emberAmber,
      builder: (context) => Container(
        width: double.infinity,
        height: double.infinity,
        color: _void,
        child: SafeArea(
          child: Padding(
            padding: const EdgeInsets.all(20),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  mainAxisAlignment: MainAxisAlignment.spaceBetween,
                  children: [
                    Text('PEOPLE', style: GoogleFonts.ibmPlexMono(color: _paper, fontSize: 14, fontWeight: FontWeight.w700, letterSpacing: 1.6)),
                    IconButton(
                      icon: const Icon(Icons.close, size: 18),
                      color: _muted,
                      onPressed: () => Navigator.of(context).pop(),
                    ),
                  ],
                ),
                const SizedBox(height: 16),
                if (people.isEmpty)
                  Text('Nobody real here yet.', style: GoogleFonts.workSans(color: _muted, fontStyle: FontStyle.italic))
                else
                  Expanded(
                    child: ListView(
                      children: _groupPeopleByRelationship(people).entries.map((group) {
                        return Padding(
                          padding: const EdgeInsets.only(bottom: 28),
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(
                                group.key.toUpperCase(),
                                style: GoogleFonts.ibmPlexMono(color: _textTertiary, fontSize: 11, letterSpacing: 1.4),
                              ),
                              const SizedBox(height: 14),
                              // Real, direct visual correction: the
                              // translucent orb is the GROUP, not each
                              // person - a single bubble containing
                              // real, clustered embers (same style as
                              // the main page's 5), not a person-level
                              // shader.
                              _GroupBubble(
                                names: group.value.map((p) => (p as Map<String, dynamic>)['name'] as String? ?? 'Unnamed').toList(),
                                clock: _clock,
                              ),
                            ],
                          ),
                        );
                      }).toList(),
                    ),
                  ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  // Real, honest grouping - by whatever relationship string values
  // actually exist in the data, not a guessed taxonomy. A missing or
  // empty relationship gets an honest fallback label rather than
  // silently dropping the person from the room.
  Map<String, List<dynamic>> _groupPeopleByRelationship(List<dynamic> people) {
    final groups = <String, List<dynamic>>{};
    for (final p in people) {
      final row = p as Map<String, dynamic>;
      final relationship = (row['relationship'] as String?)?.trim();
      final key = (relationship == null || relationship.isEmpty) ? 'Other' : relationship;
      groups.putIfAbsent(key, () => []).add(row);
    }
    return groups;
  }

  // Real, direct feedback: "when I tap an ember, does my brain
  // perceive that ember as the thing opening the room? Not tap →
  // ember animation → dialog → room animation. One event propagating
  // through the world." Deliberately not new architecture - uses
  // Flutter's own, existing Overlay mechanism to play a real, timed
  // brighten-then-propagate sequence at the exact tapped origin,
  // awaited before the existing, unmodified showOfficeRoom transform
  // takes over from the same point - one continuous handoff, not two
  // separate animations stitched together.
  Future<void> _igniteEmber(Offset origin, Color color) async {
    final overlayState = Overlay.of(context);
    final completer = Completer<void>();
    late OverlayEntry entry;
    entry = OverlayEntry(
      builder: (context) => IgnorePointer(
        child: Stack(
          children: [
            // The glow - real, declarative sequencing via flutter_animate
            // rather than hand-computed opacity/radius math. Scales
            // continuously across the full duration while opacity rises
            // quickly then recedes, matching a real pulse of light
            // spreading and dissipating rather than a solid disc
            // growing. onComplete signals the real end of the whole
            // sequence, since this is the longer-running of the two.
            Positioned(
              left: origin.dx - 210,
              top: origin.dy - 210,
              child: Container(
                width: 420,
                height: 420,
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  gradient: RadialGradient(colors: [color, color.withOpacity(0.0)]),
                ),
              )
                  .animate(onComplete: (_) => completer.complete())
                  .scaleXY(begin: 0.02, end: 1.0, duration: 380.ms, curve: Curves.easeOut)
                  .fadeIn(duration: 60.ms, curve: Curves.easeOut, begin: 0.0)
                  .then(delay: 40.ms)
                  .fadeOut(duration: 280.ms, curve: Curves.easeIn),
            ),
            // The dot - real, direct acknowledgement of touch. Fades
            // and scales up together, quickly, then holds at full
            // brightness for the remainder of the sequence.
            Positioned(
              left: origin.dx - 16,
              top: origin.dy - 16,
              child: Container(
                width: 32,
                height: 32,
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  color: color,
                  boxShadow: [BoxShadow(color: color.withOpacity(0.8), blurRadius: 16, spreadRadius: 2)],
                ),
              )
                  .animate()
                  .fadeIn(duration: 120.ms, curve: Curves.easeOut)
                  .scaleXY(begin: 0.3, end: 1.0, duration: 120.ms, curve: Curves.easeOut),
            ),
          ],
        ),
      ),
    );
    overlayState.insert(entry);
    await completer.future;
    entry.remove();
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
  final void Function(Offset) onReportsTap;
  final void Function(Offset) onPeopleTap;
  final void Function(Offset) onHistoryTap;
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

  Widget _drawerItem(IconData icon, String label, void Function(Offset) onTap, BuildContext context) {
    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      onTapDown: (details) {
        // Real, direct feedback: "the room should be born from the
        // ember." Captures the real, on-screen tap position before
        // the drawer closes - the drawer's own pop-then-callback
        // ordering would otherwise lose it entirely.
        final origin = details.globalPosition;
        Navigator.pop(context);
        onTap(origin);
      },
      child: ListTile(
        leading: Icon(icon, color: _muted),
        title: Text(label, style: GoogleFonts.workSans(color: _paper, fontSize: 15)),
      ),
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

// Real, direct feedback: "crackling flickering... not orb looking
// floating balls." The real difference between an orb and an ember
// isn't just shape - it's how the light behaves over time. A smooth
// sine wave, however irregular the outline, still reads as a solid,
// continuous surface. Real embers/sparks crackle: intensity holds
// briefly then jumps abruptly to a new, unrelated level, never a
// smooth oscillation. This returns a real, seeded pseudo-random
// value in roughly [0, 1] that steps and holds rather than glides.
double _crackleValue(double t, double speed, int seed) {
  double hashToUnit(int n) {
    final x = math.sin(n * 12.9898 + seed * 78.233) * 43758.5453;
    return x - x.floorToDouble();
  }

  final stepped = t * speed;
  final stepIndex = stepped.floor();
  final frac = stepped - stepIndex;
  final current = hashToUnit(stepIndex);
  final next = hashToUnit(stepIndex + 1);
  // Cubic ease - holds near the current value, then snaps quickly
  // toward the next one near the end of each step, mimicking a real
  // crackle rather than a smooth, even glide.
  final eased = frac * frac * frac;
  return current + (next - current) * eased;
}

// The embers, rebuilt, 2026-08-08 — "tears in the veil of the void."
// Reuses _Ember's own proven drift timing, per-instance
// randomization, and isThinking treatment wholesale rather than
// reinventing motion that already works; only the shape and paint
// technique are new. One shared FragmentProgram (loaded once at app
// level) is turned into an independent FragmentShader instance per
// ember here, so five embers never share or fight over uniform state.
class _EmberTear extends StatefulWidget {
  final ui.FragmentProgram program;
  final Color color;
  final int count;
  final VoidCallback onTap;
  final bool isThinking;
  final OfficeClock clock;
  final double seedOffset;
  const _EmberTear({
    super.key,
    required this.program,
    required this.color,
    required this.count,
    required this.onTap,
    required this.clock,
    required this.seedOffset,
    this.isThinking = false,
  });

  @override
  State<_EmberTear> createState() => _EmberTearState();
}

class _EmberTearState extends State<_EmberTear> {
  late final ui.FragmentShader _shader;
  // Real, deliberate reuse of _Ember's own proven per-instance
  // randomization — same real reasoning, same values, so the tears
  // drift with the same tuned, already-accepted "gently floating"
  // quality rather than a fresh, untested motion feel.
  late final double _driftDurationSeconds;
  late final double _driftRadiusX;
  late final double _driftRadiusY;
  late final double _phaseOffset;

  @override
  void initState() {
    super.initState();
    _shader = widget.program.fragmentShader();
    final seed = widget.color.value + widget.count;
    final random = math.Random(seed);
    _driftDurationSeconds = 20 + random.nextDouble() * 10;
    _driftRadiusX = 4 + random.nextDouble() * 5;
    _driftRadiusY = 5 + random.nextDouble() * 6;
    _phaseOffset = random.nextDouble() * 2 * math.pi;
  }

  @override
  void dispose() {
    _shader.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    // Same real, tested tiers as the old embers — never a flat
    // lit/unlit, real magnitude shown as real brightness and size.
    final double brightness;
    final double size;
    if (widget.count >= 6) {
      brightness = 1.0;
      size = 34;
    } else if (widget.count >= 3) {
      brightness = 0.85;
      size = 28;
    } else if (widget.count >= 1) {
      brightness = 0.65;
      size = 22;
    } else {
      brightness = 0.4;
      size = 16;
    }
    final effectiveColor = widget.isThinking ? widget.color : Color.lerp(_emberUnlit, widget.color, brightness)!;

    return RepaintBoundary(
      child: AnimatedBuilder(
        animation: widget.clock,
        builder: (context, child) {
          final progress = (widget.clock.elapsedSeconds / _driftDurationSeconds) % 1.0;
          final t = progress * 2 * math.pi + _phaseOffset;
          final dx = math.sin(t) * _driftRadiusX;
          final dy = math.cos(t * 0.8) * _driftRadiusY;
          return Transform.translate(
            offset: Offset(dx, dy),
            child: GestureDetector(
              onTap: widget.onTap,
              child: SizedBox(
                width: size,
                height: size * 1.7,
                child: CustomPaint(
                  painter: _EmberTearPainter(
                    shader: _shader,
                    time: widget.clock.elapsedSeconds,
                    seed: widget.seedOffset,
                    color: effectiveColor,
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

class _EmberTearPainter extends CustomPainter {
  final ui.FragmentShader shader;
  final double time;
  final double seed;
  final Color color;
  _EmberTearPainter({required this.shader, required this.time, required this.seed, required this.color});

  @override
  void paint(Canvas canvas, Size size) {
    // Uniform order must match ember_tear.frag exactly: uSize (vec2),
    // uTime (float), uSeed (float), uColor (vec3).
    shader
      ..setFloat(0, size.width)
      ..setFloat(1, size.height)
      ..setFloat(2, time)
      ..setFloat(3, seed)
      ..setFloat(4, color.red / 255.0)
      ..setFloat(5, color.green / 255.0)
      ..setFloat(6, color.blue / 255.0);
    canvas.drawRect(Offset.zero & size, Paint()..shader = shader);
  }

  @override
  bool shouldRepaint(covariant _EmberTearPainter old) =>
      old.time != time || old.color != color;
}

// Real, direct visual correction: the translucent orb is the GROUP,
// not each person - a real, translucent glass container with real,
// clustered _Ember widgets inside it (the exact same widget as the
// main page's 5 - genuine visual consistency, not a parallel
// implementation), not a person-level shader. Members are positioned
// with a deterministic golden-angle spiral so they spread evenly
// within the bubble without random overlap, and stay stable across
// rebuilds rather than jittering.
class _GroupBubble extends StatefulWidget {
  final List<String> names;
  final OfficeClock clock;
  const _GroupBubble({required this.names, required this.clock});

  @override
  State<_GroupBubble> createState() => _GroupBubbleState();
}

class _GroupBubbleState extends State<_GroupBubble> with SingleTickerProviderStateMixin {
  ui.FragmentProgram? _program;
  late AnimationController _ticker;
  final DateTime _start = DateTime.now();
  final Set<int> _revealed = {};

  @override
  void initState() {
    super.initState();
    _ticker = AnimationController(vsync: this, duration: const Duration(seconds: 1))..repeat();
    _loadShader();
  }

  Future<void> _loadShader() async {
    final program = await ui.FragmentProgram.fromAsset('shaders/group_bubble.frag');
    if (!mounted) return;
    setState(() => _program = program);
  }

  @override
  Widget build(BuildContext context) {
    final program = _program;
    final n = widget.names.length;
    final size = (90.0 + math.sqrt(n) * 35.0).clamp(90.0, 210.0);

    if (program == null) return SizedBox(width: size, height: size);

    // Real, deterministic golden-angle spiral - even distribution
    // within the bubble, no random collisions, stable across rebuilds.
    const goldenAngle = 137.5 * (math.pi / 180.0);
    final positions = <Offset>[];
    for (var i = 0; i < n; i++) {
      final angle = i * goldenAngle;
      final radiusFraction = n == 1 ? 0.0 : math.sqrt((i + 0.5) / n);
      final maxRadius = size / 2 * 0.5;
      positions.add(Offset(
        size / 2 + math.cos(angle) * radiusFraction * maxRadius - 16,
        size / 2 + math.sin(angle) * radiusFraction * maxRadius - 16,
      ));
    }

    return SizedBox(
      width: size,
      height: size + 20,
      child: Stack(
        clipBehavior: Clip.none,
        children: [
          SizedBox(
            width: size,
            height: size,
            child: AnimatedBuilder(
              animation: _ticker,
              builder: (_, __) => CustomPaint(
                painter: _GroupBubblePainter(
                  program: program,
                  time: DateTime.now().difference(_start).inMilliseconds / 1000.0,
                ),
              ),
            ),
          ),
          for (var i = 0; i < n; i++)
            Positioned(
              left: positions[i].dx,
              top: positions[i].dy,
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  SizedBox(
                    width: 32,
                    height: 32,
                    child: _Ember(
                      color: _emberAmber,
                      count: 1,
                      onTap: () => setState(() => _revealed.contains(i) ? _revealed.remove(i) : _revealed.add(i)),
                      clock: widget.clock,
                    ),
                  ),
                  AnimatedOpacity(
                    opacity: _revealed.contains(i) ? 1.0 : 0.0,
                    duration: const Duration(milliseconds: 200),
                    child: Padding(
                      padding: const EdgeInsets.only(top: 2),
                      child: Text(widget.names[i], style: GoogleFonts.workSans(color: _muted, fontSize: 10)),
                    ),
                  ),
                ],
              ),
            ),
        ],
      ),
    );
  }

  @override
  void dispose() {
    _ticker.dispose();
    super.dispose();
  }
}

class _GroupBubblePainter extends CustomPainter {
  final ui.FragmentProgram program;
  final double time;

  _GroupBubblePainter({required this.program, required this.time});

  @override
  void paint(Canvas canvas, Size size) {
    final shader = program.fragmentShader();
    // Uniform order must match group_bubble.frag exactly: uSize
    // (vec2), uTime.
    shader.setFloat(0, size.width);
    shader.setFloat(1, size.height);
    shader.setFloat(2, time);
    canvas.drawRect(Offset.zero & size, Paint()..shader = shader);
  }

  @override
  bool shouldRepaint(covariant _GroupBubblePainter old) => true;
}

double _zeroPulse() => 0.0;

class _Ember extends StatefulWidget {
  final Color color;
  final int count;
  final VoidCallback onTap;
  final bool isThinking;
  final OfficeClock clock;
  // Real, bounded milestone: "the tapped Ember becomes the source -
  // brighten, slightly intensify its glow." A function, not a static
  // value - _TalkArea is a StatelessWidget that only rebuilds on the
  // parent's setState, so a pre-computed double would freeze at
  // whatever it was at that instant rather than actually animate.
  // Re-invoked fresh on every clock tick, inside the existing
  // AnimatedBuilder below.
  final double Function() tapPulse;
  const _Ember({
    super.key,
    required this.color,
    required this.count,
    required this.onTap,
    required this.clock,
    this.isThinking = false,
    this.tapPulse = _zeroPulse,
  });

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

class _EmberState extends State<_Ember> {
  // Runtime migration: no longer owns an independent
  // AnimationController - reads phase from the shared widget.clock
  // instead. _driftDurationSeconds is now just a plain, randomized
  // number (still per-instance, so no two embers share a period) used
  // to compute where in its own cycle this ember currently is.
  late final double _driftDurationSeconds;
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
  // Real, direct feedback: "crackling flickering... not orb looking
  // floating balls." Every ember crackles now, each with its own
  // speed and seed so none are ever in sync or identical.
  late final double _crackleSpeed;
  late final int _crackleSeed;

  @override
  void initState() {
    super.initState();
    final seed = widget.color.value + widget.count;
    final random = math.Random(seed);
    _driftDurationSeconds = 20 + random.nextDouble() * 10;
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
    _crackleSpeed = 8 + random.nextDouble() * 8;
    _crackleSeed = random.nextInt(100000);
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
        animation: widget.clock,
        builder: (context, child) {
          // Real migration: reads phase from the shared clock instead
          // of an independent AnimationController - the per-instance
          // _driftDurationSeconds still gives this ember its own,
          // randomized period, exactly as the controller's own
          // duration did.
          final progress = (widget.clock.elapsedSeconds / _driftDurationSeconds) % 1.0;
          final t = progress * 2 * math.pi + _phaseOffset;
          final dx = math.sin(t) * _driftRadiusX;
          final dy = math.cos(t * 0.8) * _driftRadiusY;
          // Direct feedback: "they should slowly brighten, dim, drift,
          // wobble on a 20-30 second cycle... enough that the screen
          // never feels frozen." Same slow cycle also modulates real
          // glow intensity, not just position.
          final glowPulse = 0.85 + (math.sin(t) * 0.15);
          final actualDiameter = diameter * _sizeVariation;
          // Real, direct feedback: "crackling flickering... not orb
          // looking floating balls." Replaces the smooth, sine-based
          // flicker with the real crackle function - genuinely erratic,
          // not a smooth oscillation, applied to every ember now
          // (not just a subset), since a smooth pulse was the actual
          // cause of the "orb" read regardless of shape. Combines the
          // slow breathe cycle (gentle baseline) with the fast,
          // unpredictable crackle (the sharp component that actually
          // reads as ember rather than orb).
          final crackle = _crackleValue(t, _crackleSpeed, _crackleSeed);
          final flickerValue = 0.55 + crackle * 0.75;
          // Real, direct feedback: "one ember glows slightly brighter...
          // no loading indicator... just the fire is working." This
          // specific ember lights up regardless of its real, current
          // count while chosen as the thinking signal.
          final effectiveCore = widget.isThinking ? widget.color : core;
          final effectiveGlow = (widget.isThinking ? glowPulse * 1.8 : glowPulse * flickerValue) * (1.0 + widget.tapPulse() * 0.6);
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
    // Real bug fix, found live: BlendMode.plus without layer isolation
    // doesn't just merge the sub-blobs with each other - it interacts
    // with whatever is already painted on the canvas beneath it,
    // which contributed to the box artifact around each ember.
    // saveLayer bounds this additive blending to its own, isolated
    // layer before compositing back. Bounds enlarged to safely match
    // the same size as the OverflowBox above it - Flutter's own docs
    // describe saveLayer's bounds as a hint to the compositor rather
    // than a strictly enforced clip, but a generous size here costs
    // nothing and removes it as a possible contributing factor.
    final layerBounds = Rect.fromCircle(center: center, radius: diameter * 2.8);
    canvas.saveLayer(layerBounds, Paint());
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
          // Real, direct feedback: a sharp, high-contrast core rather
          // than one smooth, gradual falloff across the whole radius -
          // staying bright through most of its size, then falling off
          // quickly right at the edge, reading as a small, intense
          // point of light rather than a large, soft, glowing area.
          stops: const [0.0, 0.55, 1.0],
          colors: [coreColor, coreColor, core.withOpacity(0.0)],
        ).createShader(Rect.fromCircle(center: blobCenter, radius: blobRadius));
      canvas.drawCircle(blobCenter, blobRadius, blobPaint);
    }
    canvas.restore();
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
// Real orb rebuild, Stage 1, 2026-08-07 — the real material, painted.
// Deliberately minimal: only uSize and uTime reach the shader, per
// Stage 1's own explicit constraint that it must not know the Office
// has states. _CircleGlowPainter's existing halo still renders behind
// this untouched, so the shader orb inherits the same ambient glow
// the old one had, rather than needing its own second glow system.
class _Stage1OrbPainter extends CustomPainter {
  final ui.FragmentShader shader;
  final double time;
  _Stage1OrbPainter({required this.shader, required this.time});

  @override
  void paint(Canvas canvas, Size size) {
    // Uniform order must match stage1_orb.frag exactly: uSize (vec2 =
    // 2 floats), then uTime (float = 1 float).
    shader
      ..setFloat(0, size.width)
      ..setFloat(1, size.height)
      ..setFloat(2, time);
    canvas.drawRect(Offset.zero & size, Paint()..shader = shader);
  }

  @override
  bool shouldRepaint(covariant _Stage1OrbPainter old) => old.time != time;
}

// A/B experiment, brought to main: FilamentOrb, using filament_orb.frag -
// perfect sphere geometry (no SDF deformation), all "life" in emissive,
// domain-warped color rather than a lit, shaded surface - confirmed
// working, real motion, and genuinely rich detail, offline-verified
// before ever reaching a device. A single, flowing ribbon (per direct
// feedback: "notice the flow"), palette shifted toward red per direct
// instruction. Ripple trigger reuses the isRecording-transition pattern.
class _FinanceRoomContent extends StatefulWidget {
  final Map<String, String> authHeaders;
  const _FinanceRoomContent({required this.authHeaders});

  @override
  State<_FinanceRoomContent> createState() => _FinanceRoomContentState();
}

class _FinanceRoomContentState extends State<_FinanceRoomContent> {
  final _searchController = TextEditingController();
  Timer? _debounce;
  List<dynamic> _items = [];
  bool _loading = true;
  String? _error;

  @override
  void initState() {
    super.initState();
    _fetch();
  }

  Future<void> _fetch({String? search}) async {
    setState(() => _loading = true);
    try {
      final uri = Uri.parse('$officeApiBase/debug/finance-list').replace(
        queryParameters: (search != null && search.trim().isNotEmpty) ? {'search': search.trim()} : null,
      );
      final response = await http.get(uri, headers: widget.authHeaders);
      if (response.statusCode == 200) {
        final data = jsonDecode(response.body) as Map<String, dynamic>;
        if (!mounted) return;
        setState(() {
          _items = data['items'] as List? ?? [];
          _loading = false;
          _error = null;
        });
      } else {
        if (!mounted) return;
        setState(() {
          _loading = false;
          _error = 'Could not load Finance right now.';
        });
      }
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _loading = false;
        _error = 'Could not load Finance right now.';
      });
    }
  }

  void _onSearchChanged(String value) {
    _debounce?.cancel();
    _debounce = Timer(const Duration(milliseconds: 350), () => _fetch(search: value));
  }

  // Real, honest per-invoice fact - due_date, now real (see
  // worker/src/finance.ts) - rather than a fabricated paid/overdue
  // badge the backend genuinely can't support yet.
  String _dueLabel(String? dueDateIso) {
    if (dueDateIso == null) return '';
    final due = DateTime.tryParse(dueDateIso);
    if (due == null) return '';
    final days = due.difference(DateTime.now()).inDays;
    if (days < 0) return 'Overdue ${-days}d';
    if (days == 0) return 'Due today';
    return 'Due ${due.day} ${_monthAbbr(due.month)}';
  }

  String _monthAbbr(int month) {
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return months[month - 1];
  }

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      height: double.infinity,
      color: _void,
      child: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(20),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  Text('FINANCE', style: GoogleFonts.ibmPlexMono(color: _paper, fontSize: 14, fontWeight: FontWeight.w700, letterSpacing: 1.6)),
                  IconButton(
                    icon: const Icon(Icons.close, size: 18),
                    color: _muted,
                    onPressed: () => Navigator.of(context).pop(),
                  ),
                ],
              ),
              const SizedBox(height: 16),
              // Real, primary way to narrow the list, per
              // ERP_MODE_ARCHITECTURE.md's depth principle - search
              // does the real work, not a menu of filters.
              TextField(
                controller: _searchController,
                onChanged: _onSearchChanged,
                style: GoogleFonts.workSans(color: _paper, fontSize: 14),
                cursorColor: _emberRed,
                decoration: InputDecoration(
                  hintText: 'Search invoices, quotations, customers…',
                  hintStyle: GoogleFonts.workSans(color: _textTertiary, fontSize: 14),
                  isDense: true,
                  border: UnderlineInputBorder(borderSide: BorderSide(color: _textTertiary.withOpacity(0.25))),
                  enabledBorder: UnderlineInputBorder(borderSide: BorderSide(color: _textTertiary.withOpacity(0.25))),
                  focusedBorder: UnderlineInputBorder(borderSide: BorderSide(color: _emberRed.withOpacity(0.6))),
                ),
              ),
              const SizedBox(height: 8),
              if (_loading)
                const Padding(padding: EdgeInsets.only(top: 24), child: Center(child: CircularProgressIndicator(strokeWidth: 2)))
              else if (_error != null)
                Padding(
                  padding: const EdgeInsets.only(top: 24),
                  child: Text(_error!, style: GoogleFonts.workSans(color: _muted, fontStyle: FontStyle.italic)),
                )
              else if (_items.isEmpty)
                Padding(
                  padding: const EdgeInsets.only(top: 24),
                  child: Text('Nothing real here yet.', style: GoogleFonts.workSans(color: _muted, fontStyle: FontStyle.italic)),
                )
              else
                Expanded(
                  child: ListView.separated(
                    padding: const EdgeInsets.only(top: 8),
                    itemCount: _items.length,
                    separatorBuilder: (_, __) => Divider(height: 1, color: _textTertiary.withOpacity(0.1)),
                    itemBuilder: (context, index) {
                      final row = _items[index] as Map<String, dynamic>;
                      final type = row['type'] as String? ?? '';
                      final isInvoice = type == 'invoice';
                      final amount = (row['amount'] as num?)?.toStringAsFixed(0) ?? '0';
                      final statusText = isInvoice
                          ? _dueLabel(row['due_date'] as String?)
                          : (row['quotation_status'] as String? ?? '').toUpperCase();
                      final statusColor = isInvoice
                          ? (statusText.startsWith('Overdue') ? _emberRed : _muted)
                          : _muted;

                      return Padding(
                        padding: const EdgeInsets.symmetric(vertical: 14),
                        child: Row(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          mainAxisAlignment: MainAxisAlignment.spaceBetween,
                          children: [
                            Expanded(
                              child: Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  Text(row['customer_name'] as String? ?? '', style: GoogleFonts.workSans(color: _paper, fontSize: 15, fontWeight: FontWeight.w500)),
                                  const SizedBox(height: 4),
                                  Text(
                                    '${isInvoice ? 'Invoice' : 'Quotation'} · ${row['description'] ?? ''}',
                                    style: GoogleFonts.ibmPlexMono(color: _textTertiary, fontSize: 11),
                                    maxLines: 1,
                                    overflow: TextOverflow.ellipsis,
                                  ),
                                ],
                              ),
                            ),
                            const SizedBox(width: 12),
                            Column(
                              crossAxisAlignment: CrossAxisAlignment.end,
                              children: [
                                Text('R$amount', style: GoogleFonts.workSans(color: _paper, fontSize: 15, fontWeight: FontWeight.w600)),
                                const SizedBox(height: 5),
                                if (statusText.isNotEmpty)
                                  Text(statusText, style: GoogleFonts.ibmPlexMono(color: statusColor, fontSize: 10, fontWeight: FontWeight.w600, letterSpacing: 0.5)),
                              ],
                            ),
                          ],
                        ),
                      );
                    },
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }

  @override
  void dispose() {
    _debounce?.cancel();
    _searchController.dispose();
    super.dispose();
  }
}

class FilamentOrb extends StatefulWidget {
  final bool isRecording;
  final double size;
  // Real, bounded milestone: "the Orb visibly knows which Ember was
  // tapped." ignitionSeq is an incrementing counter - each real
  // increment records a new reaction start time, the same pattern
  // already proven for isRecording's own tapTime. reactColor carries
  // which ember caused it.
  final int ignitionSeq;
  final Color? reactColor;
  const FilamentOrb({
    super.key,
    required this.isRecording,
    this.size = 220,
    this.ignitionSeq = 0,
    this.reactColor,
  });

  @override
  State<FilamentOrb> createState() => _FilamentOrbState();
}

class _FilamentOrbState extends State<FilamentOrb> with SingleTickerProviderStateMixin {
  ui.FragmentProgram? _program;
  late AnimationController _ticker;
  double _tapTime = -1;
  double _ignitionTime = -1;
  Color _reactColor = _emberAmber;
  final DateTime _start = DateTime.now();

  @override
  void initState() {
    super.initState();
    _ticker = AnimationController(vsync: this, duration: const Duration(seconds: 1))..repeat();
    _loadShader();
  }

  @override
  void didUpdateWidget(covariant FilamentOrb oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.isRecording && !oldWidget.isRecording) {
      _tapTime = DateTime.now().difference(_start).inMilliseconds / 1000.0;
    }
    if (widget.ignitionSeq != oldWidget.ignitionSeq) {
      _ignitionTime = DateTime.now().difference(_start).inMilliseconds / 1000.0;
      _reactColor = widget.reactColor ?? _emberAmber;
    }
  }

  Future<void> _loadShader() async {
    final program = await ui.FragmentProgram.fromAsset('shaders/filament_orb.frag');
    if (!mounted) return;
    setState(() => _program = program);
  }

  @override
  Widget build(BuildContext context) {
    final program = _program;
    if (program == null) return const SizedBox.shrink();

    return AnimatedBuilder(
      animation: _ticker,
      builder: (_, __) {
        return CustomPaint(
          size: Size(widget.size, widget.size),
          painter: _FilamentOrbPainter(
            program: program,
            energy: widget.isRecording ? 1.0 : 0.0,
            time: DateTime.now().difference(_start).inMilliseconds / 1000.0,
            tapTime: _tapTime,
            ignitionTime: _ignitionTime,
            reactColor: _reactColor,
          ),
        );
      },
    );
  }

  @override
  void dispose() {
    _ticker.dispose();
    super.dispose();
  }
}

class _FilamentOrbPainter extends CustomPainter {
  final ui.FragmentProgram program;
  final double energy;
  final double time;
  final double tapTime;
  final double ignitionTime;
  final Color reactColor;

  _FilamentOrbPainter({
    required this.program,
    required this.energy,
    required this.time,
    required this.tapTime,
    required this.ignitionTime,
    required this.reactColor,
  });

  @override
  void paint(Canvas canvas, Size size) {
    final shader = program.fragmentShader();
    // Uniform order must match filament_orb.frag exactly: uSize
    // (vec2), uTime, uEnergy, uTapTime, uIgnitionTime, uReactColor
    // (vec3).
    shader.setFloat(0, size.width);
    shader.setFloat(1, size.height);
    shader.setFloat(2, time);
    shader.setFloat(3, energy);
    shader.setFloat(4, tapTime);
    shader.setFloat(5, ignitionTime);
    shader.setFloat(6, reactColor.red / 255.0);
    shader.setFloat(7, reactColor.green / 255.0);
    shader.setFloat(8, reactColor.blue / 255.0);

    canvas.drawRect(Offset.zero & size, Paint()..shader = shader);
  }

  @override
  bool shouldRepaint(covariant _FilamentOrbPainter old) => true;
}

// Real, direct feedback: "imagine a dark lake where these embers
// float in. It's alive. It has depth to it. It's a liquid. It's not
// a blank piece of paper." Extends the same, already-proven shader
// technique (domain-warped noise, no broad directional light) from
// just the orb to the void itself. Deliberately subtle - this is
// background, not foreground - offline-verified before ever reaching
// a device.
class VoidLake extends StatefulWidget {
  const VoidLake({super.key});

  @override
  State<VoidLake> createState() => _VoidLakeState();
}

class _VoidLakeState extends State<VoidLake> with SingleTickerProviderStateMixin {
  ui.FragmentProgram? _program;
  late AnimationController _ticker;
  final DateTime _start = DateTime.now();

  @override
  void initState() {
    super.initState();
    _ticker = AnimationController(vsync: this, duration: const Duration(seconds: 1))..repeat();
    _loadShader();
  }

  Future<void> _loadShader() async {
    final program = await ui.FragmentProgram.fromAsset('shaders/void_lake.frag');
    if (!mounted) return;
    setState(() => _program = program);
  }

  @override
  Widget build(BuildContext context) {
    final program = _program;
    // Deliberate, honest fallback - the exact, real _void color, so
    // there's never a flash of an unstyled background while the
    // shader loads.
    if (program == null) return Container(color: _void);

    return AnimatedBuilder(
      animation: _ticker,
      builder: (_, __) => CustomPaint(
        size: Size.infinite,
        painter: _VoidLakePainter(
          program: program,
          time: DateTime.now().difference(_start).inMilliseconds / 1000.0,
        ),
      ),
    );
  }

  @override
  void dispose() {
    _ticker.dispose();
    super.dispose();
  }
}

class _VoidLakePainter extends CustomPainter {
  final ui.FragmentProgram program;
  final double time;

  _VoidLakePainter({required this.program, required this.time});

  @override
  void paint(Canvas canvas, Size size) {
    final shader = program.fragmentShader();
    // Uniform order must match void_lake.frag exactly: uSize (vec2),
    // uTime.
    shader.setFloat(0, size.width);
    shader.setFloat(1, size.height);
    shader.setFloat(2, time);
    canvas.drawRect(Offset.zero & size, Paint()..shader = shader);
  }

  @override
  bool shouldRepaint(covariant _VoidLakePainter old) => true;
}

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

    // Real feature 2026-07-28 — the floor reflection from the
    // reference image: a dim, flattened glow directly beneath the
    // orb, as if it's resting on a surface rather than floating in
    // pure void.
    final floorCenter = Offset(center.dx, center.dy + coreDiameter * 0.42);
    final floorRect = Rect.fromCenter(center: floorCenter, width: coreDiameter * 0.9, height: coreDiameter * 0.22);
    final floorPaint = Paint()
      ..shader = RadialGradient(
        colors: [color.withOpacity(glowIntensity * 0.5), color.withOpacity(0.0)],
      ).createShader(floorRect);
    canvas.drawOval(floorRect, floorPaint);
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
// Real feature 2026-07-28 — the decorative, wide-field spark layer
// from the reference image. Real, seeded randomness per spark
// (position, size, drift, appear/fade timing) so none repeat or
// synchronize, rendered via a single CustomPainter — one paint pass
// for ~28 sparks, not 28 separate animating widgets, matching the
// same performance discipline as the real embers.
class _AmbientSparkField extends StatefulWidget {
  final OfficeClock clock;
  const _AmbientSparkField({required this.clock});

  @override
  State<_AmbientSparkField> createState() => _AmbientSparkFieldState();
}

class _Spark {
  final double x;
  final double y;
  final double size;
  final double driftSpeed;
  final double driftAngle;
  final double fadePhase;
  final double fadeSpeed;
  const _Spark({
    required this.x,
    required this.y,
    required this.size,
    required this.driftSpeed,
    required this.driftAngle,
    required this.fadePhase,
    required this.fadeSpeed,
  });
}

class _AmbientSparkFieldState extends State<_AmbientSparkField> {
  // Runtime migration: no longer owns its own AnimationController -
  // reads the shared widget.clock instead. The original 60-second
  // wrapping only ever fed periodic sin/cos calculations, which are
  // identical for any equivalent angle regardless of how large the
  // input gets - elapsedSeconds needs no rescaling or wrapping at all.
  late final List<_Spark> _sparks;

  @override
  void initState() {
    super.initState();
    final random = math.Random(42);
    _sparks = List.generate(28, (i) {
      return _Spark(
        x: random.nextDouble(),
        y: random.nextDouble(),
        size: 1.5 + random.nextDouble() * 3.5,
        driftSpeed: 0.004 + random.nextDouble() * 0.008,
        driftAngle: random.nextDouble() * 2 * math.pi,
        fadePhase: random.nextDouble() * 2 * math.pi,
        fadeSpeed: 0.3 + random.nextDouble() * 0.7,
      );
    });
  }

  @override
  Widget build(BuildContext context) {
    return IgnorePointer(
      child: RepaintBoundary(
        child: AnimatedBuilder(
          animation: widget.clock,
          builder: (context, child) {
            return CustomPaint(
              size: Size.infinite,
              painter: _SparkFieldPainter(sparks: _sparks, time: widget.clock.elapsedSeconds),
            );
          },
        ),
      ),
    );
  }
}

class _SparkFieldPainter extends CustomPainter {
  final List<_Spark> sparks;
  final double time;
  _SparkFieldPainter({required this.sparks, required this.time});

  @override
  void paint(Canvas canvas, Size size) {
    for (var i = 0; i < sparks.length; i++) {
      final spark = sparks[i];
      final drift = spark.driftSpeed * time;
      final dx = (spark.x + math.cos(spark.driftAngle) * drift) % 1.0;
      final dy = (spark.y - drift * 1.3) % 1.0; // drifting slowly upward, wrapping around
      // Real, direct feedback: "crackling flickering... not orb
      // looking floating balls." Real crackle instead of a smooth
      // sine wave, same fix as the 5 real embers.
      final crackle = _crackleValue(time, spark.fadeSpeed * 3, i * 7919);
      final opacity = (0.1 + crackle * 0.55).clamp(0.0, 0.65);
      final position = Offset(dx * size.width, (dy < 0 ? dy + 1.0 : dy) * size.height);
      final paint = Paint()
        ..shader = RadialGradient(
          // Sharper, smaller core - staying bright most of the way
          // out, then falling off quickly, rather than one smooth,
          // gradual fade across the whole radius.
          stops: const [0.0, 0.4, 1.0],
          colors: [_pulse.withOpacity(opacity), _pulse.withOpacity(opacity * 0.6), _pulse.withOpacity(0.0)],
        ).createShader(Rect.fromCircle(center: position, radius: spark.size * 2.2));
      canvas.drawCircle(position, spark.size, paint);
    }
  }

  @override
  bool shouldRepaint(covariant _SparkFieldPainter oldPainter) => oldPainter.time != time;
}

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

// Real feature 2026-07-28 — the persistent, time-of-day-aware
// greeting from the reference image. Distinct from the sigh state,
// which stays specifically for genuine "all clear" relief; this is
// the default, neutral welcome shown whenever nothing has been said
// yet but there's real, ordinary business state to attend to. Uses
// the real, signed-in user's email to derive a first name, rather
// than hardcoding a specific person's name into the app itself.
class _Greeting extends StatelessWidget {
  const _Greeting({this.userEmail});
  final String? userEmail;

  String get _timeOfDayGreeting {
    final hour = DateTime.now().hour;
    if (hour < 12) return 'Good morning';
    if (hour < 18) return 'Good afternoon';
    return 'Good evening';
  }

  String? get _firstName {
    if (userEmail == null || !userEmail!.contains('@')) return null;
    final local = userEmail!.split('@').first;
    final namePart = local.split(RegExp(r'[._]')).first;
    if (namePart.isEmpty) return null;
    return namePart[0].toUpperCase() + namePart.substring(1).toLowerCase();
  }

  @override
  Widget build(BuildContext context) {
    final name = _firstName;
    return Center(
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 32),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(
              name != null ? '$_timeOfDayGreeting, $name.' : '$_timeOfDayGreeting.',
              textAlign: TextAlign.center,
              style: GoogleFonts.workSans(fontSize: 19, color: _textPrimary, fontWeight: FontWeight.w400),
            ),
            const SizedBox(height: 4),
            Text(
              'How can I help?',
              textAlign: TextAlign.center,
              style: GoogleFonts.workSans(fontSize: 17, color: _textSecondary, fontWeight: FontWeight.w300),
            ),
          ],
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
  final OfficeClock clock;
  final String? thinkingEmberId;
  // Real, bounded milestone: "the Orb visibly knows which Ember was
  // tapped and reacts to it." tapPulseFor drives each ember's own
  // brief brighten; ignitionSeq/reactColor drive the orb's shader-
  // side reaction. Purely Ember → Orb - no room/route involvement.
  final double Function(String emberId) tapPulseFor;
  final int ignitionSeq;
  final Color? reactColor;
  // Real orb rebuild, Stage 1, 2026-08-07 — deliberately just a
  // shader reference and a bool, nothing state-derived passed to the
  // shader itself. Falls back to the proven old orb whenever
  // stage1Shader is null, toggle or not.
  final bool useShaderOrb;
  final ui.FragmentShader? stage1Shader;
  final bool useTearEmbers;
  final ui.FragmentProgram? emberTearProgram;
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
    required this.clock,
    required this.thinkingEmberId,
    required this.tapPulseFor,
    required this.ignitionSeq,
    required this.reactColor,
    required this.useShaderOrb,
    required this.stage1Shader,
    required this.useTearEmbers,
    required this.emberTearProgram,
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
      // Real bug fix, found live: same Stack default-clipping issue,
      // applied consistently at the outermost level too.
      clipBehavior: Clip.none,
      children: [
        // Real, direct feedback: "the embers should feel like they're
        // waiting for Peter... coals lying underneath [the button]."
        // Real feedback, 2026-08-08: "the embers are still sort of
        // under the orb... they should be aligned on the left
        // vertical." When the tear shader is active and loaded, this
        // is a genuinely different arrangement, not just a recolor —
        // vertically stacked along the left edge instead of a tight
        // horizontal cluster fighting the orb for the same small
        // patch of screen. Falls back to the exact original
        // horizontal cluster whenever the toggle is off or the
        // shader hasn't loaded yet, same discipline as the orb.
        if (useTearEmbers && emberTearProgram != null)
          Align(
            alignment: const Alignment(-0.86, 0.05),
            child: SizedBox(
              width: 60,
              height: 260,
              child: Stack(
                clipBehavior: Clip.none,
                children: [
                  Positioned(left: 12, top: 0, child: _EmberTear(program: emberTearProgram!, color: _emberAmber, count: embers.tasks, onTap: () => onEmberTap('tasks'), clock: clock, isThinking: thinkingEmberId == 'tasks', seedOffset: 0.0)),
                  Positioned(left: 4, top: 55, child: _EmberTear(program: emberTearProgram!, color: _emberBlue, count: embers.scheduler, onTap: () => onEmberTap('scheduler'), clock: clock, isThinking: thinkingEmberId == 'scheduler', seedOffset: 1.0)),
                  Positioned(left: 16, top: 110, child: _EmberTear(key: _financeEmberKey, program: emberTearProgram!, color: _emberRed, count: embers.finance, onTap: () => onEmberTap('finance'), clock: clock, isThinking: thinkingEmberId == 'finance', seedOffset: 2.0)),
                  Positioned(left: 2, top: 165, child: _EmberTear(program: emberTearProgram!, color: _emberPurple, count: embers.suppliers, onTap: () => onEmberTap('suppliers'), clock: clock, isThinking: thinkingEmberId == 'suppliers', seedOffset: 3.0)),
                  Positioned(left: 14, top: 220, child: _EmberTear(program: emberTearProgram!, color: _emberSage, count: embers.pending, onTap: () => onEmberTap('pending'), clock: clock, isThinking: thinkingEmberId == 'pending', seedOffset: 4.0)),
                ],
              ),
            ),
          )
        else
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
                // Real bug fix, found live: same Stack default-clipping
                // issue as the primary circle - each ember's own
                // OverflowBox glow can genuinely exceed this small
                // 160x60 container, and Stack's default Clip.hardEdge
                // would cut it off right at that boundary.
                clipBehavior: Clip.none,
                children: [
                  Positioned(left: 10, top: 18, child: _Ember(color: _emberAmber, count: embers.tasks, onTap: () => onEmberTap('tasks'), clock: clock, isThinking: thinkingEmberId == 'tasks', tapPulse: () => tapPulseFor('tasks'))),
                  Positioned(left: 46, top: 2, child: _Ember(color: _emberBlue, count: embers.scheduler, onTap: () => onEmberTap('scheduler'), clock: clock, isThinking: thinkingEmberId == 'scheduler', tapPulse: () => tapPulseFor('scheduler'))),
                  Positioned(left: 74, top: 24, child: _Ember(key: _financeEmberKey, color: _emberRed, count: embers.finance, onTap: () => onEmberTap('finance'), clock: clock, isThinking: thinkingEmberId == 'finance', tapPulse: () => tapPulseFor('finance'))),
                  Positioned(left: 104, top: 6, child: _Ember(color: _emberPurple, count: embers.suppliers, onTap: () => onEmberTap('suppliers'), clock: clock, isThinking: thinkingEmberId == 'suppliers', tapPulse: () => tapPulseFor('suppliers'))),
                  Positioned(left: 132, top: 20, child: _Ember(color: _emberSage, count: embers.pending, onTap: () => onEmberTap('pending'), clock: clock, isThinking: thinkingEmberId == 'pending', tapPulse: () => tapPulseFor('pending'))),
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
                  animation: clock,
                  builder: (context, child) {
                // Real migration: reads the shared clock instead of
                // its own, independent AnimationController. A smooth
                // sine wave over an 8-second period - genuinely
                // smoother than the original's linear triangle wave
                // (0..1..0 via reverse:true), and a better match for
                // "breathe" as a metaphor.
                final breatheValue = (math.sin(clock.elapsedSeconds * (2 * math.pi / 8)) + 1) / 2;
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
                      // Real bug fix, found live: Stack defaults to
                      // Clip.hardEdge, clipping children to its own
                      // 160x160 bounds regardless of OverflowBox's own
                      // no-clip behavior - very likely the actual,
                      // remaining cause of the box artifact around the
                      // circle even after the earlier OverflowBox fix.
                      clipBehavior: Clip.none,
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
                        // Real orb rebuild, Stage 1, swapped for
                        // FilamentOrb (brought over from the A/B
                        // experiment branch) - confirmed working, real
                        // motion, genuinely rich detail, now the
                        // chosen orb. useShaderOrb still required, or
                        // this falls straight back to the exact,
                        // untouched original gradient Container below
                        // - the proven orb stays reachable no matter
                        // what.
                        if (useShaderOrb)
                          SizedBox(
                            width: 96,
                            height: 96,
                            child: FilamentOrb(isRecording: isRecording, size: 96, ignitionSeq: ignitionSeq, reactColor: reactColor),
                          )
                        else
                          Container(
                            width: 96,
                            height: 96,
                            decoration: BoxDecoration(
                              shape: BoxShape.circle,
                              // Real feature 2026-07-28 — reworked with
                              // real, tuned color stops for a rim-light
                              // effect and softer, more gradual falloff,
                              // matching the reference image's layered
                              // depth rather than one flat two-color
                              // gradient: a bright highlight near the
                              // light source, the main body color, a
                              // darker mid-tone for real depth, then a
                              // brighter rim right at the edge -
                              // simulating light wrapping around a
                              // sphere.
                              gradient: RadialGradient(
                                center: const Alignment(-0.3, -0.3),
                                stops: const [0.0, 0.35, 0.75, 1.0],
                                colors: isRecording
                                    ? [
                                        Color.lerp(_pulse, Colors.white, 0.35)!,
                                        _pulse,
                                        const Color(0xFF8B0000),
                                        const Color(0xFFFF6B4A),
                                      ]
                                    : isAllClear
                                        ? [
                                            Color.lerp(_breathe, Colors.white, 0.35)!,
                                            _breathe,
                                            const Color(0xFF1A5F55),
                                            const Color(0xFF5FD9C4),
                                          ]
                                        : [
                                            Color.lerp(_pulse, Colors.white, 0.35)!,
                                            _pulse,
                                            const Color(0xFF8B0000),
                                            const Color(0xFFFF6B4A),
                                          ],
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
              const SizedBox(height: 14),
              // Real feature 2026-07-28 — the persistent subtitle from
              // the reference image, matched directly.
              Text(
                'TAP OR HOLD TO SPEAK',
                style: GoogleFonts.ibmPlexMono(color: _textTertiary, fontSize: 11, letterSpacing: 1.6),
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
// Real feature 2026-08-06 — the void stays a void. Replaces the
// permanent ledger entirely: at most one office message is ever
// visible on screen, and even that one dissolves once read, the
// mirror of Peter's own words dissolving via WordField. No chat
// bubbles, no scroll history, no memory of the exchange left showing
// — matching Rule 3's fuller intent, not the partial, additive version
// this started as.
//
// One real, non-negotiable safety rule this widget must never violate:
// a message carrying an unresolved guard()'d pending item (a real
// payment, invoice, quotation, or fact awaiting confirmation) NEVER
// auto-dissolves while any item on it is still PendingStatus.pending.
// It holds open until Peter actually confirms or rejects every item.
// The void can wait. A live money decision cannot be timed out from
// under him. Enforced by simply never arming the dissolve timer while
// that's true, re-checked on every rebuild — not by touching the
// confirm/reject rendering itself, which stays exactly _MessageLine's
// existing, already-proven UI, completely untouched.
class _ActiveResponse extends StatefulWidget {
  final ChatMessage? message;
  final void Function(int itemId) onConfirm;
  final void Function(int itemId) onReject;
  final VoidCallback onDismissed;
  const _ActiveResponse({
    required this.message,
    required this.onConfirm,
    required this.onReject,
    required this.onDismissed,
  });

  @override
  State<_ActiveResponse> createState() => _ActiveResponseState();
}

class _ActiveResponseState extends State<_ActiveResponse> with SingleTickerProviderStateMixin {
  late final AnimationController _controller;
  Timer? _dissolveTimer;
  String? _shownId;

  // Real feature 2026-08-06 — "structure from chaos," the mirror of
  // Peter's own words dissolving into scatter on the input side.
  // Deliberately NOT literal per-glyph particle tracing — that needs
  // real glyph outline sampling, a genuinely bigger, separate build.
  // This is a small, fixed number of scattered light points
  // converging loosely into the response's own real layout area
  // (fractional target coordinates resolved against the actual
  // CustomPaint canvas size at paint time, which matches _MessageLine's
  // real bounds since Stack sizes to its largest child) — an
  // atmospheric convergence, not a precise trace, on purpose: Pierre
  // asked for subtle, and a precise letter-trace would read as the
  // showier, more theatrical version of this idea, not the quieter
  // one. Reusing the exact same seeded-offset-as-pure-function pattern
  // already proven in word_field.dart, for the same reason — safe to
  // reason about frame to frame, no hidden mutable state.
  static const int _particleCount = 22;
  List<_ParticleSeed> _particles = const [];

  @override
  void initState() {
    super.initState();
    _controller = AnimationController(vsync: this, duration: const Duration(milliseconds: 650));
    _maybeStart();
  }

  @override
  void didUpdateWidget(covariant _ActiveResponse oldWidget) {
    super.didUpdateWidget(oldWidget);
    _maybeStart();
  }

  void _maybeStart() {
    final msg = widget.message;
    if (msg == null) return;
    if (msg.id != _shownId) {
      // A genuinely new message — reset and play the crystallize-in
      // from the start. A confirm/reject tap on the SAME message
      // must never replay this; only a real new arrival does.
      _shownId = msg.id;
      _particles = _seedParticles(msg.id);
      _dissolveTimer?.cancel();
      _dissolveTimer = null;
      _controller
        ..reset()
        ..forward();
    }
    _maybeArmDissolve();
  }

  List<_ParticleSeed> _seedParticles(String seed) {
    final rand = math.Random(seed.hashCode);
    return List.generate(_particleCount, (i) {
      final angle = rand.nextDouble() * 2 * math.pi;
      final radius = 80.0 + rand.nextDouble() * 130.0;
      return _ParticleSeed(
        startOffset: Offset(math.cos(angle) * radius, math.sin(angle) * radius),
        targetDx: 0.08 + rand.nextDouble() * 0.84,
        targetDy: 0.12 + rand.nextDouble() * 0.76,
      );
    });
  }

  bool get _hasUnresolvedPending =>
      widget.message?.pendingItems.any((p) => p.status == PendingStatus.pending) ?? false;

  void _maybeArmDissolve() {
    final msg = widget.message;
    if (msg == null) return;
    if (_hasUnresolvedPending) {
      _dissolveTimer?.cancel();
      _dissolveTimer = null;
      return;
    }
    if (_dissolveTimer != null) return;
    // Generous, deliberate reading time for a real answer, not a
    // single word — roughly 25 characters/second skim speed, floored
    // and capped. If it just resolved a pending item, Peter already
    // read it once while deciding, so a short acknowledgement hold is
    // enough rather than a full re-read window.
    final justResolved = msg.pendingItems.isNotEmpty;
    final holdMs = justResolved ? 2600 : (2500 + msg.text.length * 40).clamp(3000, 14000);
    _dissolveTimer = Timer(Duration(milliseconds: holdMs), () async {
      // Reusing the same controller in reverse means the light
      // scatters back outward as the response leaves — order
      // returning to chaos on the way out, the same real system
      // playing backward, not a second effect built to match.
      await _controller.reverse();
      if (mounted) widget.onDismissed();
    });
  }

  @override
  void dispose() {
    _dissolveTimer?.cancel();
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final msg = widget.message;
    if (msg == null) return const SizedBox.shrink();
    final hasPending = msg.pendingItems.isNotEmpty;

    // Real feedback, 2026-08-07: "it still looks like a chat bubble" —
    // not because of any literal box or fill, there never was one, but
    // because a sender label plus a colored accent bar plus a
    // top-pinned paragraph is chat-app grammar on its own. The orb is
    // visibly who's speaking; a plain response no longer needs a
    // header announcing that. The pending-item stamp keeps its own
    // label and _MessageLine rendering completely unchanged underneath
    // — it's a fundamentally different, already-distinct confirm/
    // reject UI, not what this feedback was about, and not worth the
    // risk of touching. Both cases now share the same bottom-center
    // anchor, above the orb, rather than pinned top-left like a
    // notification that arrived.
    return Align(
      alignment: Alignment.bottomCenter,
      child: Padding(
        padding: EdgeInsets.symmetric(horizontal: hasPending ? 16 : 32, vertical: 8),
        child: Stack(
          clipBehavior: Clip.none,
          alignment: Alignment.center,
          children: [
            // The real content — deliberately delayed relative to the
            // particles (Interval starts at 0.35, not 0.0) so the
            // light visibly gathers first, then resolves into
            // readable words, rather than both cross-fading in at the
            // same flat rate.
            FadeTransition(
              opacity: CurvedAnimation(
                parent: _controller,
                curve: const Interval(0.35, 1.0, curve: Curves.easeOut),
              ),
              child: hasPending
                  ? _MessageLine(message: msg, onConfirm: widget.onConfirm, onReject: widget.onReject)
                  : Text(
                      msg.text,
                      textAlign: TextAlign.center,
                      style: GoogleFonts.workSans(
                        fontSize: 16.5,
                        color: _paper,
                        height: 1.45,
                        shadows: [
                          Shadow(color: _pulse.withOpacity(0.55), blurRadius: 26),
                          Shadow(color: _pulse.withOpacity(0.22), blurRadius: 54),
                        ],
                      ),
                    ),
            ),
            // The converging light — ignores touch, purely atmospheric,
            // fully faded and inert well before the hold phase begins.
            IgnorePointer(
              child: AnimatedBuilder(
                animation: _controller,
                builder: (context, _) => CustomPaint(
                  size: Size.infinite,
                  painter: _ConvergingLightPainter(progress: _controller.value, particles: _particles),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

// Pure seed data, resolved against real canvas size only at paint
// time — the same discipline as WordParticle in word_field.dart.
class _ParticleSeed {
  final Offset startOffset; // absolute px, relative to canvas center — independent of size
  final double targetDx; // 0..1 fraction of the real canvas width at paint time
  final double targetDy; // 0..1 fraction of the real canvas height at paint time
  const _ParticleSeed({required this.startOffset, required this.targetDx, required this.targetDy});
}

class _ConvergingLightPainter extends CustomPainter {
  final double progress; // 0..1, straight from _controller — reversible for free
  final List<_ParticleSeed> particles;
  _ConvergingLightPainter({required this.progress, required this.particles});

  @override
  void paint(Canvas canvas, Size size) {
    final eased = Curves.easeOutCubic.transform(progress.clamp(0.0, 1.0));
    final opacity = (1.0 - eased).clamp(0.0, 1.0);
    if (opacity <= 0.0) return;

    final center = size.center(Offset.zero);
    for (final p in particles) {
      final target = Offset(size.width * p.targetDx, size.height * p.targetDy);
      final start = center + p.startOffset;
      final pos = Offset.lerp(start, target, eased)!;
      final glowOpacity = (opacity * 0.85).clamp(0.0, 1.0);
      final glowPaint = Paint()
        ..shader = RadialGradient(
          colors: [_paper.withOpacity(glowOpacity), _paper.withOpacity(0.0)],
        ).createShader(Rect.fromCircle(center: pos, radius: 4.0));
      canvas.drawCircle(pos, 2.2, glowPaint);
    }
  }

  @override
  bool shouldRepaint(covariant _ConvergingLightPainter old) => old.progress != progress;
}

class _MessageLine extends StatelessWidget {
  final ChatMessage message;
  final void Function(int itemId) onConfirm;
  final void Function(int itemId) onReject;

  const _MessageLine({required this.message, required this.onConfirm, required this.onReject});

  // Real cleanup, 2026-08-07: this used to dispatch across a plain
  // labeled line, a status placeholder, and the stamp — back when
  // _MessageLine rendered every row of a permanent ledger. It's now
  // called from exactly one place (_ActiveResponse), and only when
  // the message already has pending items, confirmed by tracing every
  // call site rather than assumed. _buildStatus() and the old
  // PETER/OFFICE-labeled _buildLine() were unreachable as a result —
  // status never showed here (the ember carries that signal instead),
  // and plain text now renders directly in _ActiveResponse without a
  // sender label at all. Removed rather than left as dead paths no
  // future session could tell were safe to call. _MessageLine is now
  // honestly just the stamp — the one thing this widget still does
  // that nothing else builds.
  @override
  Widget build(BuildContext context) => _buildStamp();

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

