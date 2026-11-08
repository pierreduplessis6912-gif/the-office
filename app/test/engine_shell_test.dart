// The engine shell (lib/engine/engine_shell.dart), first step of the visible slice: the persistent orb, a typed question, the answer card. It runs against the engine's real recorded answers (test/fixtures/slice) through a fake API. What this pins:
// the orb is there from the start and stays; a typed question brings an answer card with the figures the engine gave, formatted and not calculated, and the source it names; a restricted member sees a boundary and NO figure; a business without
// the capability is told so honestly; an unknown customer, a question the script does not understand, and two customers with one name each get their own honest answer. It does not test the shader or layout on a device.
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:the_office/engine/engine_api.dart';
import 'package:the_office/engine/engine_orb.dart';
import 'package:the_office/engine/engine_shell.dart';

late Map<String, EngineResponse> _fx;

Future<void> _open(WidgetTester tester, EngineApi api) async {
  await tester.pumpWidget(MaterialApp(home: EngineShell(api: api, clock: () => DateTime(2026, 11, 7))));
  await tester.pump(const Duration(milliseconds: 50));
}

Future<void> _ask(WidgetTester tester, String question) async {
  await tester.enterText(find.byKey(const Key('ask-field')), question);
  await tester.tap(find.byKey(const Key('ask-send')));
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 100));
}

Future<void> _tap(WidgetTester tester, Finder finder) async {
  await tester.ensureVisible(finder);
  await tester.pump();
  await tester.tap(finder);
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 100));
}

Future<FixtureEngineApi> _answered(WidgetTester tester, {bool canRecord = true, bool staleApproval = false, bool canDecline = true, bool overpay = false}) async {
  final api = FixtureEngineApi(_fx, canRecord: canRecord, staleApproval: staleApproval, canDecline: canDecline, overpay: overpay);
  await _open(tester, api);
  await _ask(tester, 'What does Mokoena owe me?');
  return api;
}

Future<void> _openInvoice(WidgetTester tester, EngineApi api) async {
  await _open(tester, api);
  await _ask(tester, 'What does Mokoena owe me?');
  await _tap(tester, find.byKey(const Key('open-document-1')));
}

void main() {
  setUpAll(() {
    _fx = <String, EngineResponse>{};
    for (final f in Directory('test/fixtures/slice').listSync().whereType<File>()) {
      if (!f.path.endsWith('.json')) continue;
      final name = f.uri.pathSegments.last.replaceAll('.json', '');
      final parsed = EngineResponse.fromFixtureJson(f.readAsStringSync());
      if (parsed != null) _fx[name] = parsed;
    }
  });

  testWidgets('opening shows the orb and an empty void, with nothing answered', (tester) async {
    await _open(tester, FixtureEngineApi(_fx));
    expect(find.byType(EngineOrb), findsOneWidget);
    expect(find.byKey(const Key('ask-field')), findsOneWidget);
    expect(find.byKey(const Key('answer-total')), findsNothing);
  });

  testWidgets('a typed question brings the answer card, with the figures and the source, and the orb stays', (tester) async {
    await _open(tester, FixtureEngineApi(_fx));
    await _ask(tester, 'What does Mokoena owe me?');
    expect(find.text('Mokoena'), findsOneWidget);
    expect(find.byKey(const Key('answer-total')), findsOneWidget);
    expect(find.text('R850.00'), findsOneWidget);
    expect(find.text('Invoice #1'), findsOneWidget);
    expect(find.text('issued 2026-10-01 · R1,150.00 · paid R300.00'), findsOneWidget);
    expect(find.text('R850.00 outstanding'), findsOneWidget);
    expect(find.textContaining('ledger.outstandingForParty'), findsOneWidget);
    expect(find.byType(EngineOrb), findsOneWidget);
    expect(find.textContaining('Patel'), findsNothing);
  });

  testWidgets('a restricted member sees a boundary and no figure', (tester) async {
    await _open(tester, FixtureEngineApi(_fx, role: 'installer'));
    await _ask(tester, 'What does Mokoena owe me?');
    expect(find.text('NOT AVAILABLE FOR YOUR ROLE'), findsOneWidget);
    expect(find.textContaining('R850'), findsNothing);
    expect(find.textContaining('R1,150'), findsNothing);
    expect(find.byKey(const Key('answer-total')), findsNothing);
    expect(find.byType(EngineOrb), findsOneWidget);
  });

  testWidgets('a business without the capability is told so honestly, with no figure', (tester) async {
    await _open(tester, FixtureEngineApi(_fx, capabilityAvailable: false));
    await _ask(tester, 'What does Mokoena owe me?');
    expect(find.text('NOT AVAILABLE'), findsOneWidget);
    expect(find.textContaining('not available for this business'), findsOneWidget);
    expect(find.byKey(const Key('answer-total')), findsNothing);
  });

  testWidgets('an unknown customer is answered as unknown', (tester) async {
    await _open(tester, FixtureEngineApi(_fx));
    await _ask(tester, 'What does Nobody owe me?');
    expect(find.text('There is no such customer.'), findsOneWidget);
    expect(find.byKey(const Key('answer-total')), findsNothing);
  });

  testWidgets('a question the script does not understand is said plainly, and nothing is asked of the engine', (tester) async {
    await _open(tester, FixtureEngineApi(_fx));
    await _ask(tester, 'hello there');
    expect(find.textContaining('I can only answer what a customer owes'), findsOneWidget);
    expect(find.byKey(const Key('answer-total')), findsNothing);
  });

  testWidgets('two customers with one name are offered, not guessed', (tester) async {
    await _open(tester, FixtureEngineApi(_fx, ambiguous: true));
    await _ask(tester, 'What does Mokoena owe me?');
    expect(find.text('WHICH ONE?'), findsOneWidget);
    expect(find.text('Mokoena (customer 1)'), findsOneWidget);
    expect(find.text('Mokoena (customer 2)'), findsOneWidget);
    expect(find.byKey(const Key('answer-total')), findsNothing);
  });

  testWidgets('a second question replaces the first answer', (tester) async {
    await _open(tester, FixtureEngineApi(_fx));
    await _ask(tester, 'What does Mokoena owe me?');
    expect(find.byKey(const Key('answer-total')), findsOneWidget);
    await _ask(tester, 'What does Nobody owe me?');
    expect(find.byKey(const Key('answer-total')), findsNothing);
    expect(find.text('There is no such customer.'), findsOneWidget);
  });

  testWidgets('tapping the invoice opens it as a room: its figures, its line, its payments with the correction, and the orb stays', (tester) async {
    await _openInvoice(tester, FixtureEngineApi(_fx));
    expect(find.byKey(const Key('room-title')), findsOneWidget);
    expect(find.text('Invoice #1'), findsOneWidget);
    expect(find.byKey(const Key('answer-total')), findsNothing);
    expect(find.byType(EngineOrb), findsOneWidget);
    expect(find.text('Total: R1,150.00'), findsOneWidget);
    expect(find.text('Paid: R300.00'), findsOneWidget);
    expect(find.text('Outstanding: R850.00'), findsOneWidget);
    expect(find.text('Vinyl plank · 2 m2 at R500.00'), findsOneWidget);
    expect(find.text('Payment 1 · R300.00 · reversed'), findsOneWidget);
    expect(find.text('Payment 2 · R300.00 · stands'), findsOneWidget);
    expect(find.text('customer: Mokoena'), findsOneWidget);
    expect(find.textContaining('payment.allocation_reversed'), findsOneWidget);
    expect(find.textContaining('derived by ledger.documentTotals'), findsWidgets);
    expect(find.textContaining('Patel'), findsNothing);
  });

  testWidgets('back to the conversation returns the answer, and the orb never left', (tester) async {
    await _openInvoice(tester, FixtureEngineApi(_fx));
    await _tap(tester, find.byKey(const Key('room-conversation')));
    expect(find.byKey(const Key('room-title')), findsNothing);
    expect(find.byKey(const Key('answer-total')), findsOneWidget);
    expect(find.text('R850.00'), findsOneWidget);
    expect(find.byType(EngineOrb), findsOneWidget);
    expect(find.byKey(const Key('ask-field')), findsOneWidget);
  });

  testWidgets('a payment opens as its own record and back steps one level at a time', (tester) async {
    await _openInvoice(tester, FixtureEngineApi(_fx));
    expect(find.byKey(const Key('room-back')), findsNothing);
    await _tap(tester, find.text('Payment 1 · R300.00 · reversed'));
    expect(find.text('Payment 1'), findsOneWidget);
    expect(find.text('Status: reversed'), findsOneWidget);
    expect(find.text('Amount: R300.00'), findsOneWidget);
    expect(find.byKey(const Key('room-back')), findsOneWidget);
    await _tap(tester, find.byKey(const Key('room-back')));
    expect(find.text('Invoice #1'), findsOneWidget);
    expect(find.byKey(const Key('room-back')), findsNothing);
    await _tap(tester, find.byKey(const Key('room-conversation')));
    expect(find.byKey(const Key('answer-total')), findsOneWidget);
  });

  testWidgets('the customer opens from the invoice, with its documents and payments', (tester) async {
    await _openInvoice(tester, FixtureEngineApi(_fx));
    await _tap(tester, find.text('customer: Mokoena'));
    expect(find.text('Name: Mokoena'), findsOneWidget);
    expect(find.text('Outstanding: R850.00'), findsOneWidget);
    expect(find.text('Invoice #1 · 2026-10-01 · R850.00 outstanding'), findsOneWidget);
    expect(find.text('Payment 2 · R300.00'), findsOneWidget);
  });

  testWidgets('a record the engine will not show leaves the person where they are, with a plain line', (tester) async {
    await _openInvoice(tester, FixtureEngineApi(_fx));
    await _tap(tester, find.text('payment: Payment 2'));
    expect(find.text('That record is not available.'), findsOneWidget);
    expect(find.text('Invoice #1'), findsOneWidget);
    expect(find.byType(EngineOrb), findsOneWidget);
  });

  testWidgets('a new question closes the room', (tester) async {
    await _openInvoice(tester, FixtureEngineApi(_fx));
    await _ask(tester, 'What does Nobody owe me?');
    expect(find.byKey(const Key('room-title')), findsNothing);
    expect(find.text('There is no such customer.'), findsOneWidget);
  });

  testWidgets('"Record R500 from Mokoena" is proposed and shown for approval with what the approver needs, and nothing is recorded', (tester) async {
    final api = await _answered(tester);
    await _ask(tester, 'Record R500 from Mokoena');
    expect(api.proposals.length, 1);
    expect(api.proposals.single, equals(<String, Object?>{'partyId': 1, 'amountMinor': 50000, 'currency': 'ZAR', 'occurredOn': '2026-11-07', 'allocate': 'oldest_first'}));
    expect(find.text('AWAITING YOUR APPROVAL'), findsOneWidget);
    expect(find.byKey(const Key('approval-title')), findsOneWidget);
    expect(find.text('From: Mokoena'), findsOneWidget);
    expect(find.text('Amount: R500.00'), findsOneWidget);
    expect(find.text('Invoice #1: R500.00'), findsOneWidget);
    expect(find.text('Applied oldest first: the Office chose this, you did not say.'), findsOneWidget);
    expect(find.text('Dated 2026-11-07: today, assumed.'), findsOneWidget);
    expect(find.text('You said: "Record R500 from Mokoena"'), findsOneWidget);
    expect(find.textContaining('Based on account version'), findsOneWidget);
    expect(find.text('Nothing is recorded until you approve.'), findsOneWidget);
    expect(find.byType(EngineOrb), findsOneWidget);
    expect(api.confirmations, isEmpty);
  });

  testWidgets('approving records it and the answer is read again: R350.00', (tester) async {
    final api = await _answered(tester);
    await _ask(tester, 'Record R500 from Mokoena');
    await _tap(tester, find.byKey(const Key('approve')));
    expect(api.confirmations, [1]);
    expect(find.text('Recorded R500.00 from Mokoena.'), findsOneWidget);
    expect(find.text('R350.00'), findsOneWidget);
    expect(find.text('issued 2026-10-01 · R1,150.00 · paid R800.00'), findsOneWidget);
    expect(find.text('AWAITING YOUR APPROVAL'), findsNothing);
    expect(find.byType(EngineOrb), findsOneWidget);
  });

  testWidgets('the invoice opened after approval shows the new payment', (tester) async {
    await _answered(tester);
    await _ask(tester, 'Mokoena paid R500');
    await _tap(tester, find.byKey(const Key('approve')));
    await _tap(tester, find.byKey(const Key('open-document-1')));
    expect(find.text('Outstanding: R350.00'), findsOneWidget);
    expect(find.text('said in capture 2, understood by script, proposal 1, approved by accountant@example.com, payment.record v1'), findsOneWidget);
  });

  testWidgets('before any approval the invoice shows no trail line, because none exists', (tester) async {
    await _openInvoice(tester, FixtureEngineApi(_fx));
    expect(find.textContaining('said in capture'), findsNothing);
  });

  testWidgets('a member who may read but not record is refused with the engine\'s words, and nothing is held', (tester) async {
    final api = await _answered(tester, canRecord: false);
    await _ask(tester, 'Record R500 from Mokoena');
    expect(find.text('Recording a payment needs permission this member does not have, so nothing was done.'), findsOneWidget);
    expect(find.text('AWAITING YOUR APPROVAL'), findsNothing);
    expect(api.proposals.length, 1);
    expect(api.confirmations, isEmpty);
  });

  testWidgets('an approval after the account changed is refused as stale, and nothing is said to be recorded', (tester) async {
    final api = await _answered(tester, staleApproval: true);
    await _ask(tester, 'Record R500 from Mokoena');
    await _tap(tester, find.byKey(const Key('approve')));
    expect(api.confirmations, [1]);
    expect(find.text('The account changed after this was proposed, so it needs to be proposed again.'), findsOneWidget);
    expect(find.textContaining('Recorded'), findsNothing);
    expect(find.text('R350.00'), findsNothing);
  });

  testWidgets('leaving the approval keeps the payment held, says so, and it can be reviewed again', (tester) async {
    final api = await _answered(tester);
    await _ask(tester, 'Record R500 from Mokoena');
    await _tap(tester, find.byKey(const Key('approval-conversation')));
    expect(find.text('AWAITING YOUR APPROVAL'), findsNothing);
    expect(find.text('R850.00'), findsOneWidget);
    expect(find.text('A payment of R500.00 is waiting for your approval. Review it.'), findsOneWidget);
    expect(api.confirmations, isEmpty);
    await _tap(tester, find.byKey(const Key('review-waiting')));
    expect(find.text('AWAITING YOUR APPROVAL'), findsOneWidget);
  });

  testWidgets('a payment is only taken for the customer on screen, and without an answer the Office asks first', (tester) async {
    final api = FixtureEngineApi(_fx);
    await _open(tester, api);
    await _ask(tester, 'Record R500 from Mokoena');
    expect(find.text('Ask what Mokoena owes first, so I know which customer you mean.'), findsOneWidget);
    expect(api.proposals, isEmpty);
    await _ask(tester, 'What does Mokoena owe me?');
    await _ask(tester, 'Record R500 from Patel');
    expect(find.text('Ask what Patel owes first, so I know which customer you mean.'), findsOneWidget);
    expect(api.proposals, isEmpty);
  });

  testWidgets('declining a held payment records nothing, says so, and returns to the answer', (tester) async {
    final api = await _answered(tester);
    await _ask(tester, 'Record R500 from Mokoena');
    await _tap(tester, find.byKey(const Key('decline')));
    expect(api.rejections, [1]);
    expect(api.confirmations, isEmpty);
    expect(find.text('Declined. R500.00 from Mokoena was not recorded.'), findsOneWidget);
    expect(find.text('AWAITING YOUR APPROVAL'), findsNothing);
    expect(find.text('R850.00'), findsOneWidget);
    expect(find.textContaining('waiting for your approval'), findsNothing);
    expect(find.byType(EngineOrb), findsOneWidget);
  });

  testWidgets('a decline the engine refuses leaves the payment waiting and says why', (tester) async {
    final api = await _answered(tester, canDecline: false);
    await _ask(tester, 'Record R500 from Mokoena');
    await _tap(tester, find.byKey(const Key('decline')));
    expect(api.rejections, [1]);
    expect(find.text('not available for your role'), findsOneWidget);
    expect(find.text('AWAITING YOUR APPROVAL'), findsOneWidget);
    expect(find.byKey(const Key('approve')), findsOneWidget);
  });

  testWidgets('a payment larger than what is owed is held with the unallocated remainder showing, and approving records it', (tester) async {
    final api = await _answered(tester, overpay: true);
    await _ask(tester, 'Record R1000 from Mokoena');
    expect(find.text('AWAITING YOUR APPROVAL'), findsOneWidget);
    expect(find.text('Amount: R1,000.00'), findsOneWidget);
    expect(find.text('Invoice #1: R850.00'), findsOneWidget);
    expect(find.byKey(const Key('approval-unallocated')), findsOneWidget);
    expect(find.text('Not applied to any invoice: R150.00. It stays on the account as unallocated.'), findsOneWidget);
    expect(api.confirmations, isEmpty);
    await _tap(tester, find.byKey(const Key('approve')));
    expect(find.text('Recorded R1,000.00 from Mokoena. R150.00 of it is on the account, not applied to an invoice.'), findsOneWidget);
    expect(find.text('R0.00'), findsOneWidget);
  });

  testWidgets('a payment fully applied shows no unallocated line', (tester) async {
    await _answered(tester);
    await _ask(tester, 'Record R500 from Mokoena');
    expect(find.byKey(const Key('approval-unallocated')), findsNothing);
  });
}
