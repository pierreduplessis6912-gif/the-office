// The owner's "Subscription" item: asks the server for a short-lived, signed link to the plans page (POST /billing/plans-link, owner only) and says what happened. The link is bound by the server to this owner's address and this business and opens in the
// phone's own browser, which carries no session, so the signature IS the credential. Pure logic with no plugins, so it can be tested without a device: test/plans_link_test.dart.
import 'dart:convert';

import 'package:http/http.dart' as http;

enum PlansLinkOutcome { ready, signedOut, notOwner, unavailable }

class PlansLinkResult {
  PlansLinkResult.ready(Uri this.url) : outcome = PlansLinkOutcome.ready;
  PlansLinkResult.signedOut() : outcome = PlansLinkOutcome.signedOut, url = null;
  PlansLinkResult.notOwner() : outcome = PlansLinkOutcome.notOwner, url = null;
  PlansLinkResult.unavailable() : outcome = PlansLinkOutcome.unavailable, url = null;

  final PlansLinkOutcome outcome;
  final Uri? url;

  /// What to tell the person. Empty when the link is ready (nothing to say: the browser opens).
  String get message {
    switch (outcome) {
      case PlansLinkOutcome.ready:
        return '';
      case PlansLinkOutcome.signedOut:
        return 'Please sign in again.';
      case PlansLinkOutcome.notOwner:
        return 'Only the owner can manage the subscription.';
      case PlansLinkOutcome.unavailable:
        return 'The plans page is not available right now. Please try again.';
    }
  }
}

/// Shown when the link was fine but the phone could not open a browser.
const String plansCouldNotOpenMessage = 'Could not open the browser. Please try again.';

/// A link is opened ONLY if it is exactly what the server makes: https, on our own host, at /billing/plans, with a token, and with no credentials, no odd port and no fragment. Anything else is refused, so even a wrong or tampered response can never
/// send an owner to another site.
Uri? trustedPlansUrl(Object? raw, String apiBase) {
  if (raw is! String) return null;
  final parsed = Uri.tryParse(raw);
  final base = Uri.tryParse(apiBase);
  if (parsed == null || base == null) return null;
  if (parsed.scheme != 'https' || parsed.host.isEmpty || parsed.host != base.host) return null;
  if (parsed.userInfo.isNotEmpty || (parsed.hasPort && parsed.port != 443) || parsed.hasFragment) return null;
  if (parsed.path != '/billing/plans') return null;
  final token = parsed.queryParameters['t'];
  if (token == null || token.isEmpty) return null;
  return parsed;
}

/// Asks for the link. Never throws: every failure (a refusal, a bad answer, no network) becomes an outcome the screen can word.
Future<PlansLinkResult> requestPlansLink({required String apiBase, required Map<String, String> headers}) async {
  try {
    final response = await http.post(Uri.parse('$apiBase/billing/plans-link'), headers: headers);
    switch (response.statusCode) {
      case 200:
        final decoded = jsonDecode(response.body);
        final url = decoded is Map ? trustedPlansUrl(decoded['url'], apiBase) : null;
        return url == null ? PlansLinkResult.unavailable() : PlansLinkResult.ready(url);
      case 401:
        return PlansLinkResult.signedOut();
      case 403:
        return PlansLinkResult.notOwner();
      default:
        return PlansLinkResult.unavailable();
    }
  } catch (_) {
    return PlansLinkResult.unavailable();
  }
}
