// A customer's phone and email in the profile (lib/customer_contact_model.dart). What this pins: they are shown when the server sends them, in the order phone then email, and a missing, empty, blank or wrongly typed value is never shown and never throws.
import 'package:flutter_test/flutter_test.dart';
import 'package:the_office/customer_contact_model.dart';

void main() {
  test('phone and email are shown, phone first', () {
    final c = {'id': 1, 'name': 'Mr Buitendacht', 'phone': '+27 81 234 5675', 'email': 'b@x.co'};
    expect(customerPhone(c), '+27 81 234 5675');
    expect(customerEmail(c), 'b@x.co');
    expect(contactLines(c), ['+27 81 234 5675', 'b@x.co']);
  });

  test('only what exists is shown', () {
    expect(contactLines({'phone': '+27 81 234 5675'}), ['+27 81 234 5675']);
    expect(contactLines({'email': 'b@x.co'}), ['b@x.co']);
    expect(contactLines({'phone': null, 'email': null}), isEmpty);
    expect(contactLines({}), isEmpty);
  });

  test('blank, wrongly typed or hostile values are not shown and nothing throws', () {
    for (final v in <Object?>['', '   ', '\n\t', 5, 5.5, true, <Object?>['a'], <String, Object?>{'a': 1}]) {
      expect(customerPhone({'phone': v}), isNull, reason: '$v');
      expect(customerEmail({'email': v}), isNull, reason: '$v');
      expect(contactLines({'phone': v, 'email': v}), isEmpty, reason: '$v');
    }
    expect(contactLines({'phone': 'a\u0000b\u0007c', 'email': ' x@y.co\n'}), ['a b c', 'x@y.co']);
    expect(customerPhone({'phone': '1' * 500})!.length, 120);
  });
}
