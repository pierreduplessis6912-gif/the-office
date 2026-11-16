// What a person types as rand becomes whole cents exactly as typed (lib/engine/money_input.dart): nothing is rounded or guessed, and anything unclear is null so the form can say so.
import 'package:flutter_test/flutter_test.dart';
import 'package:the_office/engine/money_input.dart';

void main() {
  test('clear amounts become exact cents', () {
    expect(randToMinor('450'), 45000);
    expect(randToMinor('450.5'), 45050);
    expect(randToMinor('450.50'), 45050);
    expect(randToMinor('R450.00'), 45000);
    expect(randToMinor('r 450'), 45000);
    expect(randToMinor('0.05'), 5);
    expect(randToMinor('1 234.50'), 123450);
    expect(randToMinor('1,234.50'), 123450);
    expect(randToMinor('1,234'), 123400);
    expect(randToMinor('450,50'), 45050);
    expect(randToMinor('450,5'), 45050);
  });

  test('anything unclear, empty, zero, negative or finer than a cent is null', () {
    for (final bad in ['', ' ', 'R', 'abc', '0', '0.00', '-5', '450.555', '450.', '.50', '1.2.3', '4 5 0x', '1e5']) {
      expect(randToMinor(bad), isNull, reason: bad);
    }
  });

  test('quantities become exact thousandths; anything unclear, zero or finer than a thousandth is null', () {
    expect(quantityToMilli('2'), 2000);
    expect(quantityToMilli('2.5'), 2500);
    expect(quantityToMilli('0.125'), 125);
    expect(quantityToMilli('0,5'), 500);
    expect(quantityToMilli(' 12 '), 12000);
    for (final bad in ['', '0', '0.000', '-1', '1.2345', 'abc', '1.', '.5', '2 m', '9999999']) {
      expect(quantityToMilli(bad), isNull, reason: bad);
    }
  });
}
