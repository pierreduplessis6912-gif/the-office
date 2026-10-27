// A customer's phone number and email as the profile shows them (backend: customers.phone and customers.email, migration 0003; GET /customers). Reads what the server sends strictly and never throws: a value that is not text, or is empty, is simply not shown.
const int _maxLength = 120;

String? _clean(Object? v) {
  if (v is! String) return null;
  final cleaned = v.replaceAll(RegExp(r'[\u0000-\u001f\u007f]'), ' ').trim();
  if (cleaned.isEmpty) return null;
  return cleaned.length > _maxLength ? cleaned.substring(0, _maxLength) : cleaned;
}

/// The phone number, or null when the customer has none.
String? customerPhone(Map<String, dynamic> customer) => _clean(customer['phone']);

/// The email address, or null when the customer has none.
String? customerEmail(Map<String, dynamic> customer) => _clean(customer['email']);

/// The lines to show under the customer's name and address, in order: phone, then email. Empty when there is neither.
List<String> contactLines(Map<String, dynamic> customer) {
  final phone = customerPhone(customer);
  final email = customerEmail(customer);
  return [if (phone != null) phone, if (email != null) email];
}
