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
  await tester.pumpWidget(MaterialApp(home: EngineShell(api: api)));
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
}
