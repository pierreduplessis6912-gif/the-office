// What a person types as an amount of rand, turned into whole cents exactly as typed. No rounding and no guessing: anything that is not a clear positive amount with at most two decimals is null, and the form
// says so. (The engine checks the amount again; this only stops something useless being sent.)
int? randToMinor(String text) {
  var s = text.replaceAll(RegExp(r'\s'), '');
  if (s.isEmpty) return null;
  if (s.startsWith('R') || s.startsWith('r')) s = s.substring(1);
  if (s.isEmpty) return null;
  // one comma followed by one or two digits is a decimal comma ("450,50"); any other comma is a thousands separator
  if (RegExp(r'^\d+,\d{1,2}$').hasMatch(s)) {
    s = s.replaceFirst(',', '.');
  } else {
    s = s.replaceAll(',', '');
  }
  final m = RegExp(r'^(\d+)(?:\.(\d{1,2}))?$').firstMatch(s);
  if (m == null) return null;
  final whole = int.tryParse(m.group(1)!);
  if (whole == null || whole > 9007199254740) return null;
  final frac = (m.group(2) ?? '').padRight(2, '0');
  final minor = whole * 100 + int.parse(frac.isEmpty ? '0' : frac);
  return minor > 0 ? minor : null;
}
