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
}
