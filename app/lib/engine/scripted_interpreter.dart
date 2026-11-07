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
