// Front-end slice 12 (lib/refusal_view.dart): how a refusal reads. What this pins: every topic the backend can name (read from worker/src/refusals.ts, so a topic added there without words here fails this test) has words; the heading says the right thing for a whole refusal and for a part; the way forward is offered only for a whole refusal; the topics are distinct and bounded; and what a screen reader hears is one plain sentence. It does not test the drawing: that needs a device.
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:the_office/refusal_view.dart';
import 'package:the_office/reply_envelope.dart';

EnvelopeRefusal _r(String reason, String topic) => EnvelopeRefusal(reason: reason, topic: topic);

List<String> _backendTopics() {
  File? f;
  for (final p in ['../worker/src/refusals.ts', 'worker/src/refusals.ts']) {
    if (File(p).existsSync()) f = File(p);
  }
  if (f == null) throw StateError('worker/src/refusals.ts not found from ${Directory.current.path}');
  final out = <String>[];
  for (final m in RegExp(r'export const (?:CANNOT_RECORD_TOPICS|WITHHELD_SEE_TOPICS|WITHHELD_RECORD_TOPICS|CANNOT_SEE_TOPICS) = \[([^\]]*)\]').allMatches(f.readAsStringSync())) {
    out.addAll(RegExp(r'"([a-z_]+)"').allMatches(m.group(1)!).map((x) => x.group(1)!));
  }
  return out;
}

void main() {
  test('every topic the backend can name has words (read from the backend\'s own vocabulary)', () {
    final topics = _backendTopics();
    expect(topics.length, greaterThanOrEqualTo(20));
    for (final t in topics) {
      expect(topicWords.containsKey(t), isTrue, reason: 'no words for the topic $t');
    }
  });

  test('a topic with no words is still shown, never hidden', () {
    expect(topicLabel('financial_analysis'), 'FINANCIAL ANALYSIS');
    expect(topicLabel('debtors'), 'WHO OWES WHAT');
    expect(topicLabel('some_new_topic'), 'SOME NEW TOPIC');
  });

  test('the topics are distinct, in the order given, and at most four', () {
    expect(refusalTopics([_r('role_cannot_see', 'debtors'), _r('role_cannot_see', 'debtors'), _r('role_cannot_see', 'open_orders')]), ['WHO OWES WHAT', 'OPEN ORDERS']);
    final many = [for (final t in ['a_one', 'b_two', 'c_three', 'd_four', 'e_five', 'f_six']) _r('role_cannot_see', t)];
    expect(refusalTopics(many), ['A ONE', 'B TWO', 'C THREE', 'D FOUR']);
    expect(refusalTopics(const []), isEmpty);
  });

  test('the heading is about the role: a whole refusal to see, a whole refusal to record, a part withheld, a part not saved', () {
    expect(refusalHeading([_r('role_cannot_see', 'debtors')], whole: true), 'NOT AVAILABLE FOR YOUR ROLE');
    expect(refusalHeading([_r('role_cannot_record', 'money')], whole: true), 'YOUR ROLE CANNOT RECORD THIS');
    expect(refusalHeading([_r('role_cannot_see_part', 'customer_balance')], whole: false), 'PART WITHHELD FOR YOUR ROLE');
    expect(refusalHeading([_r('role_cannot_record_part', 'sensitive_details')], whole: false), 'PART NOT SAVED FOR YOUR ROLE');
  });

  test('the way forward is offered for a whole refusal only', () {
    expect(refusalHint(whole: true), 'Ask the business owner if you need this.');
    expect(refusalHint(whole: false), isNull);
  });

  test('what a screen reader hears is one plain piece: the heading, the topics, the server\'s words, the hint', () {
    final whole = refusalSpeech([_r('role_cannot_see', 'financial_analysis')], 'That is restricted for this member\'s role.', whole: true);
    expect(whole, 'not available for your role: financial analysis. That is restricted for this member\'s role.. Ask the business owner if you need this.'.replaceAll('..', '.'));
    final part = refusalSpeech([_r('role_cannot_see_part', 'customer_balance')], 'Jenny has an open quotation.', whole: false);
    expect(part, 'part withheld for your role: customer balance. Jenny has an open quotation.');
    expect(refusalSpeech(const [], 'Hello.', whole: false), 'part withheld for your role. Hello.');
  });
}
