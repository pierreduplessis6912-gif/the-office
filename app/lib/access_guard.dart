// What the app does when the server says this business has stopped paying. The backend refuses every request from a lapsed business with `401 {"code": "access_ended"}` (worker/src/access.ts). Without this the app would just show broken screens.
// ONE client wraps every request the app makes (main.dart installs it with http.runWithClient, so none of the call sites change): it looks only at 401 responses, and only a 401 whose body says access_ended raises the signal. Every response, including that
// 401, is handed back to the caller exactly as it arrived. The signal clears the stored session and swaps the whole home for a calm "subscription ended" screen, after closing any dialog that was open on top of it. Pinned in test/access_guard_test.dart.
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;

/// The one signal the whole app shares (main.dart wires its side effect).
final AccessSignal accessSignal = AccessSignal();

/// Raised once when the server reports that this business's access has ended. [onEnded] is a side effect (clearing the stored session) and can never break the signal.
class AccessSignal {
  final ValueNotifier<bool> ended = ValueNotifier<bool>(false);
  void Function()? onEnded;

  void trigger() {
    if (ended.value) return; // once: every other request in flight is refused the same way
    ended.value = true;
    try {
      onEnded?.call();
    } catch (_) {
      // a failure to clear the session must never stop the screen from appearing
    }
  }

  void reset() => ended.value = false;
}

/// True only for a body that is a JSON object whose `code` is exactly `access_ended`.
bool isAccessEndedBody(List<int> bytes) {
  try {
    final decoded = jsonDecode(utf8.decode(bytes));
    return decoded is Map && decoded['code'] == 'access_ended';
  } catch (_) {
    return false;
  }
}

/// Wraps a shared client. Only a 401 response is read (its body is buffered and handed back unchanged); everything else streams through untouched.
class AccessAwareClient extends http.BaseClient {
  AccessAwareClient(this._inner, this._signal);

  final http.Client _inner;
  final AccessSignal _signal;

  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) async {
    final response = await _inner.send(request);
    if (response.statusCode != 401) return response;
    final bytes = await response.stream.toBytes();
    if (isAccessEndedBody(bytes)) _signal.trigger();
    return http.StreamedResponse(
      http.ByteStream.fromBytes(bytes),
      response.statusCode,
      contentLength: bytes.length,
      request: response.request,
      headers: response.headers,
      isRedirect: response.isRedirect,
      persistentConnection: response.persistentConnection,
      reasonPhrase: response.reasonPhrase,
    );
  }

  /// package:http makes and CLOSES a client for every top-level call. The inner client is shared for the life of the app, so closing it after one request would break every later one: closing here does nothing.
  @override
  void close() {}
}

/// Shows [child] normally; when the signal is raised, closes anything open on top and shows the "subscription ended" screen instead. "Sign in" clears the signal, so the home is built afresh and finds no session.
class AccessGate extends StatefulWidget {
  const AccessGate({super.key, required this.signal, required this.navigatorKey, required this.child});

  final AccessSignal signal;
  final GlobalKey<NavigatorState> navigatorKey;
  final Widget child;

  @override
  State<AccessGate> createState() => _AccessGateState();
}

class _AccessGateState extends State<AccessGate> {
  @override
  void initState() {
    super.initState();
    widget.signal.ended.addListener(_changed);
  }

  @override
  void dispose() {
    widget.signal.ended.removeListener(_changed);
    super.dispose();
  }

  void _changed() {
    if (widget.signal.ended.value) widget.navigatorKey.currentState?.popUntil((route) => route.isFirst); // a dialog open at the moment of the 401 must not stay on top
    if (mounted) setState(() {});
  }

  @override
  Widget build(BuildContext context) => widget.signal.ended.value ? AccessEndedScreen(onSignIn: widget.signal.reset) : widget.child;
}

class AccessEndedScreen extends StatelessWidget {
  const AccessEndedScreen({super.key, required this.onSignIn});

  final VoidCallback onSignIn;

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    return Scaffold(
      body: SafeArea(
        child: Center(
          child: Padding(
            padding: const EdgeInsets.all(32),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 420),
              child: Semantics(
                container: true,
                liveRegion: true,
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text('Your subscription has ended', style: text.headlineSmall),
                    const SizedBox(height: 16),
                    Text(
                      "This business's subscription has ended, or its payment is overdue. Your information is safe and has not been deleted.",
                      style: text.bodyLarge,
                    ),
                    const SizedBox(height: 12),
                    Text('Sign in again to see what you can do to get back in.', style: text.bodyMedium),
                    const SizedBox(height: 28),
                    FilledButton(onPressed: onSignIn, child: const Text('Sign in')),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
