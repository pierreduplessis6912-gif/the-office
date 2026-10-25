// Front-end slice 12: how a refusal LOOKS and SOUNDS (ENVELOPE.md, version 2). The server now says in structure when it refused someone because of their role: why (a closed vocabulary) and about what (a topic: never a person, an amount or free text). This file turns that vocabulary into plain words for the screen and for a screen reader. It is pure so it can be tested; the drawing is in main.dart.
// The design (agreed by showing Pierre a picture): a refusal is a BOUNDARY, not an error, so it is never red. It is a dimmed ember (a hollow ring) with a quiet heading, the topic as a small chip, the server's own words, and where there is a way forward, one line saying so. A whole refusal replaces the answer; a PART refusal leaves the real answer alone and adds only a quiet note beneath it.
import 'reply_envelope.dart';

/// Every topic the server can name, in words. A topic not in this table is still shown (its underscores removed), never hidden.
const Map<String, String> topicWords = {
  // role_cannot_record
  'money': 'MONEY', 'leads': 'LEADS', 'statements': 'STATEMENTS', 'stock': 'STOCK',
  // role_cannot_see
  'material_prices': 'MATERIAL PRICES', 'open_orders': 'OPEN ORDERS', 'supplier_statements': 'SUPPLIER STATEMENTS', 'unit_conversions': 'UNIT CONVERSIONS',
  'delivery_exceptions': 'DELIVERY EXCEPTIONS', 'financial_overview': 'FINANCIAL OVERVIEW', 'debtors': 'WHO OWES WHAT', 'financial_analysis': 'FINANCIAL ANALYSIS',
  // role_cannot_see_part
  'outstanding_balances': 'OUTSTANDING BALANCES', 'quotation_activity': 'QUOTATION ACTIVITY', 'expense_activity': 'EXPENSE ACTIVITY', 'financial_performance': 'FINANCIAL PERFORMANCE',
  'supplier_balances': 'SUPPLIER BALANCES', 'job_activity': 'JOB ACTIVITY', 'customer_balance': 'CUSTOMER BALANCE', 'job_profitability': 'JOB PROFITABILITY',
  // role_cannot_record_part
  'sensitive_details': 'SENSITIVE DETAILS',
};

/// The topic as a short label: from the table, else the topic with its underscores removed, in capitals.
String topicLabel(String topic) => topicWords[topic] ?? topic.replaceAll('_', ' ').toUpperCase();

/// The distinct topic labels, in the order the server gave them, at most four (the rest are not lost: the words carry them).
List<String> refusalTopics(List<EnvelopeRefusal> refusals) {
  final seen = <String>[];
  for (final r in refusals) {
    final label = topicLabel(r.topic);
    if (!seen.contains(label)) seen.add(label);
    if (seen.length == 4) break;
  }
  return seen;
}

/// The quiet heading. A WHOLE refusal is about the role being unable to see or record the thing; a PART refusal says only that part of an answer was held back.
String refusalHeading(List<EnvelopeRefusal> refusals, {required bool whole}) {
  if (whole) return refusals.any((r) => r.reason == 'role_cannot_record') ? 'YOUR ROLE CANNOT RECORD THIS' : 'NOT AVAILABLE FOR YOUR ROLE';
  return refusals.any((r) => r.reason == 'role_cannot_record_part') ? 'PART NOT SAVED FOR YOUR ROLE' : 'PART WITHHELD FOR YOUR ROLE';
}

/// The one line about the way forward, only for a whole refusal (a part refusal still gave a real answer). Null when there is nothing to add.
String? refusalHint({required bool whole}) => whole ? 'Ask the business owner if you need this.' : null;

/// What a screen reader says, in one piece: the heading, the topics, then the server's own words and the hint.
String refusalSpeech(List<EnvelopeRefusal> refusals, String message, {required bool whole}) {
  final topics = refusalTopics(refusals);
  final hint = refusalHint(whole: whole);
  final parts = <String>[
    refusalHeading(refusals, whole: whole).toLowerCase() + (topics.isEmpty ? '' : ': ${topics.map((t) => t.toLowerCase()).join(', ')}'),
    message,
    if (hint != null) hint,
  ];
  return parts.join('. ').replaceAll('..', '.');
}
