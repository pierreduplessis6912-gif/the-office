// First slice, interpretation SCRIPTED (docs/decisions/first-slice.md, criterion 13): the engine has no conversation path yet (an engine business refuses /messages/text), so the shell understands exactly one kind of question by a fixed
// pattern: "what does X owe me?" and its close forms. Anything else is not understood, and the shell says so honestly rather than guessing. This is a placeholder for a real interpreter, not an interpreter: it decides nothing but
// which customer name to ask the engine about, and the engine decides what that person may see.
final RegExp _owes = RegExp(r'^(?:what|how much)\s+(?:does|do|is)\s+(.+?)\s+(?:owe|owing)\b', caseSensitive: false);

/// The customer name a question asks about, or null when the question is not one the script understands.
String? scriptedCustomerName(String text) {
  final match = _owes.firstMatch(text.trim());
  if (match == null) return null;
  final name = match.group(1)!.trim();
  if (name.isEmpty || name.length > 60) return null;
  return name;
}

/// A payment the person says was made: who paid and how much, in whole minor units. Nothing here records anything; it is only what the words said.
class ScriptedPayment {
  final String customerName;
  final int amountMinor;
  const ScriptedPayment({required this.customerName, required this.amountMinor});
}

final RegExp _recordFrom = RegExp(r'^record\s+r?\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)\s+from\s+(.+?)\s*[.!]?$', caseSensitive: false);
final RegExp _paid = RegExp(r'^(.+?)\s+paid\s+(?:me\s+|us\s+)?r?\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)\s*[.!]?$', caseSensitive: false);

/// "R1,150.50" or "500" to whole minor units, by integer arithmetic only (no decimals). Null for zero, nothing, or too large to be sensible.
int? _toMinor(String text) {
  final parts = text.replaceAll(',', '').split('.');
  if (parts.isEmpty || parts[0].isEmpty || parts[0].length > 10) return null;
  final whole = int.tryParse(parts[0]);
  if (whole == null) return null;
  var cents = 0;
  if (parts.length == 2) {
    final c = int.tryParse(parts[1].padRight(2, '0'));
    if (c == null) return null;
    cents = c;
  }
  final total = whole * 100 + cents;
  return total < 1 ? null : total;
}

/// "Record R500 from Mokoena" and "Mokoena paid R500" (and close forms), or null when the words are not a payment the script understands.
ScriptedPayment? scriptedPayment(String text) {
  final t = text.trim();
  final a = _recordFrom.firstMatch(t);
  final String? name;
  final String? amount;
  if (a != null) {
    amount = a.group(1);
    name = a.group(2);
  } else {
    final b = _paid.firstMatch(t);
    if (b == null) return null;
    name = b.group(1);
    amount = b.group(2);
  }
  if (name == null || amount == null) return null;
  final trimmed = name.trim();
  final minor = _toMinor(amount);
  if (trimmed.isEmpty || trimmed.length > 60 || minor == null) return null;
  return ScriptedPayment(customerName: trimmed, amountMinor: minor);
}
