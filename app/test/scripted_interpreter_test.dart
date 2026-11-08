// lib/engine/scripted_interpreter.dart. What this pins: the one scripted question and its close forms yield the customer name, and anything else is not understood (null), so the shell never guesses.
import 'package:flutter_test/flutter_test.dart';
import 'package:the_office/engine/scripted_interpreter.dart';

void main() {
  test('what a customer owes, in its close forms', () {
    expect(scriptedCustomerName('What does Mokoena owe me?'), 'Mokoena');
    expect(scriptedCustomerName('what does mokoena owe'), 'mokoena');
    expect(scriptedCustomerName('How much does Mokoena owe us'), 'Mokoena');
    expect(scriptedCustomerName('How much is Mokoena owing?'), 'Mokoena');
    expect(scriptedCustomerName('  What does Patel Builders owe me?  '), 'Patel Builders');
  });

  test('anything else is not understood', () {
    expect(scriptedCustomerName(''), isNull);
    expect(scriptedCustomerName('hello'), isNull);
    expect(scriptedCustomerName('Record R500 from Mokoena'), isNull);
    expect(scriptedCustomerName('What does owe me?'), isNull);
    expect(scriptedCustomerName('What does ${'x' * 80} owe me?'), isNull);
  });

  test('a payment the person says was made, in whole minor units', () {
    final a = scriptedPayment('Record R500 from Mokoena')!;
    expect(a.customerName, 'Mokoena');
    expect(a.amountMinor, 50000);
    expect(scriptedPayment('record r1,150.50 from Patel Builders.')!.amountMinor, 115050);
    expect(scriptedPayment('record R500.5 from Mokoena')!.amountMinor, 50050);
    expect(scriptedPayment('Mokoena paid R500')!.customerName, 'Mokoena');
    expect(scriptedPayment('Mokoena paid me 500')!.amountMinor, 50000);
    expect(scriptedPayment('Patel Builders paid us R1,150')!.amountMinor, 115000);
  });

  test('anything that is not a clear payment is not taken', () {
    expect(scriptedPayment('Record R0 from Mokoena'), isNull);
    expect(scriptedPayment('Record R500 from'), isNull);
    expect(scriptedPayment('Record from Mokoena'), isNull);
    expect(scriptedPayment('Mokoena paid'), isNull);
    expect(scriptedPayment('What does Mokoena owe me?'), isNull);
    expect(scriptedPayment('Record R99999999999 from Mokoena'), isNull);
    expect(scriptedPayment(''), isNull);
  });
}
