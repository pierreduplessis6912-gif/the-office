> **Status:** proposed 2026-11-16, waiting for Pierre's go. **Verified:** not yet. **Owns:** none.

# Create from the screen: forms that propose, never write

## Today
The app reads everything (rooms) and the owner makes things by talking to the assistant. There is no "New customer" button. The app can already propose one thing (a payment, scripted) through `POST /engine/proposals`, which the engine HOLDS until a person approves it in the Pending room.

## Recommendation
1. **A form is another way to say a sentence.** It fills the same payload the assistant would, sends it to `POST /engine/proposals`, and the engine validates and checks it exactly as it does for a sentence. Nothing is recorded until the owner approves it. No new engine capability, no new permission, no migration.
2. **One generic call in the app:** `EngineApi.propose(capability, payload, transcript)` replaces the payment-only call (the payment call stays working). The transcript is a plain line the app writes ("Added from the New customer form").
3. **The engine's refusal is the form's error message.** The form shows the engine's own reason ("name must be 2 to 60 characters") and keeps what was typed. The app never decides a business rule.
4. **Figures:** the person types rand (`450.00`); the app turns exactly what was typed into whole cents (no rounding: more than two decimals is refused on screen) and sends that. The approval card shows the amount the engine will record, so a slip is caught there.
5. **First three forms, one at a time:**
   - F1 New customer or supplier (`party.create`): name, customer/supplier, optional phone and email.
   - F2 Record a payment received (`payment.record`): customer picked from the list, amount, date, method, which bank account (only shown when there is more than one), "pay the oldest invoices first".
   - F3 Record an expense (`expense.record`): supplier, date, category, method, amount, VAT included yes/no, tax invoice held yes/no.
6. **Where the buttons live:** a "+" in the Customers and suppliers room (F1), in the Invoices room (F2) and in the Expenses room (F3). After sending, the form says it is waiting for approval and links to the Pending room.
7. **Not in this step:** invoices and quotations (they have lines and need a line editor), editing a record, supplier invoices and purchase orders, voiding. They stay with the assistant; each is a later form.

## Cost
App only: `propose`, one small form widget per form (validated on screen for the obvious, the engine for the rest), Dart tests, fixtures. Engine: one fixture-style test that a form's exact payload is held and approved like a sentence's.

## Limits to state plainly
- A form is available only to someone who may propose that capability; the engine refuses the rest and the form shows why.
- No offline queue: a form needs the engine to answer.
