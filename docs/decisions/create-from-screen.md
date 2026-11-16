> **Status:** approved 2026-11-16 (Pierre: "Yes"); F1, F2 and F3 built. **Verified:** not yet. **Owns:** none.

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

## F1 as built (2026-11-16): new customer or supplier
- App: `EngineApi.propose(capability, payload, transcript)` (HTTP posts to `/engine/proposals`; the fixture client records what was proposed). `PartyForm` (name, person or business, customer and/or supplier, optional phone and email) sends the exact `party.create` payload, shows "Sent for approval" or the engine's own reason, and keeps what was typed on a refusal. A "+" in the customers and suppliers room opens it; closing it reads the list again. The app refuses only an empty name or no role.
- Engine: no change. `tools/engine-form-payloads.test.js` pins that the form's payload is held (nothing recorded), recorded on approval, and refused with the engine's own reason for a used name, a blank name, no role, or a role that may not add parties.
- Umbrella 11775/11775; the app's compile check and Dart tests are proved by CI.
- Next: nothing pending in this note.

## F2 as built (2026-11-16): record a payment received
- `PaymentForm` behind a "+" (key `invoices-pay`) in the Invoices room. Customer picked from the customers list; it shows what they owe from the engine's own receivables figure; amount typed in rand becomes exact cents (`randToMinor`, never rounded or guessed); date prefilled with today; method; bank account asked only when there is more than one and the method is not cash; oldest-first switch. It proposes `payment.record` and never writes; the engine's own refusal reason is shown. A customer with no invoices is refused on screen (no currency is guessed).
- Proof: Dart `money_input_test`, `payment_form_test`; engine `engine-form-payloads` (15) covers the payload held, approved, bad account, cash with account, zero amount, wrong role.
- Also fixed: `scheduleJob` (mcp-changes.ts) read the SAST-shifted clock with local getters, so under a SAST process timezone it double-shifted and refused "today" after 22:00; it now reads UTC getters.

## F3 as built (2026-11-16): record an expense
- `ExpenseForm` behind a "+" (key `expenses-add`) in the Expenses room. Supplier from the suppliers list; amount in rand to exact cents; optional "what it was for" (falls back to the category); date paid (used for incurred and paid); category (the engine's own list, which it re-checks); method; bank account only with more than one account and not for cash; "has VAT (15%)" and "amount already includes VAT" switches; "I have the tax invoice". One line per expense, currency ZAR; several lines are still said to the assistant. It proposes `expense.record` and never writes; the engine's reason is shown.
- Proof: Dart `expense_form_test` (6); engine `engine-form-payloads` (20) covers held, approved, unknown category, cash with an account, wrong role. Umbrella 11786/11786.
