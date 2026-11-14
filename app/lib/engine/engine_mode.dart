// Which kind of business the signed-in person is in, read from GET /auth/me (docs/decisions/app-connection.md, decision 2). The app shows the engine shell ONLY when the server says so; anything else, including an older
// server that does not send a mode, is treated as the existing app. A signed-out answer says nothing about the mode.
enum BusinessMode { engine, legacy, unknown }

BusinessMode businessModeFrom(Object? authMeBody) {
  if (authMeBody is! Map || authMeBody['signedIn'] != true) return BusinessMode.unknown;
  final mode = authMeBody['mode'];
  if (mode == 'engine') return BusinessMode.engine;
  if (mode == 'legacy') return BusinessMode.legacy;
  return BusinessMode.unknown;
}

/// True only when the server said engine. Callers use this, never `!= legacy`, so an unknown answer cannot open the engine shell.
bool showsEngineShell(BusinessMode mode) => mode == BusinessMode.engine;
