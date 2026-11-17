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

## Next forms: what the code says (2026-11-16, for Pierre's approval before building)
- **Quotation (`quotation.create`)** can be a form now: customer, issue date, valid until, reference, and a line editor (description, quantity, unit, unit price, VAT 15% or 0%). The engine already works out the totals and shows them on approval. The editor is the new part: add and remove lines, each line checked on screen only for "not empty".
- **Invoice (CORRECTED 2026-11-17: this paragraph was wrong; see "Invoice form as built").** I first wrote that an invoice form needs a new engine capability. It does not: the engine already has draft routes (open, save, read) that need no approval, and only issuing is held. The paragraph below is the original, kept for the record. Invoice cannot be a form yet. The engine only issues an invoice from an existing draft (`invoice.issue` takes a draft number), and nothing in the engine creates a draft; today drafts come only from the older app. So an invoice form needs a new engine capability first (`invoice.draft`: customer, date, lines, held, then issue), with its own tests. Proposed order: build the quotation form and its line editor, then reuse the editor for the draft form.
- **Smaller forms, no approval needed (same pattern as F1 to F3):** F4 pay a supplier (`supplier_payment.record`, from the Bills room) and F5 refund an overpayment (`payment.refund`, which may name a bank account).
- Approval: say "Yes" to build the quotation form and then the invoice draft capability and form in that order.

## F4 as built (2026-11-16): pay a supplier
- `SupplierPaymentForm` behind a "+" (key `bills-pay`) in the Bills room: supplier, amount in rand, date, method, bank account (only with more than one and not cash), "pay the oldest bills first". Proposes `supplier_payment.record`, never writes; ZAR; the engine's reason is shown (for example when nothing is payable to that supplier).
- Proof: Dart `supplier_payment_form_test`; engine `engine-form-payloads` (23). The held-then-paid path is proven by the existing supplier payment suites (the form test has no bill to settle).
- **F5 (refund an overpayment): built 2026-11-17, see below.** (I first wrote that the engine had no read that lists payments and needed a new one; wrong: `credits.find`, GET /engine/credits, already lists payments with money left.)

## Quotation form as built (2026-11-17)
- `QuotationForm` behind a "+" (key `quotes-add`) in the Quotes room, using a reusable `LineEditor` (rows of description, quantity, unit, price in rand, "add VAT 15%"; add and remove lines; a bad line is refused on screen naming which one). Quantities become exact thousandths (`quantityToMilli`), prices exact cents. Proposes `quotation.create`, never writes; the engine works out and shows the totals on approval and its reason is shown on a refusal. ZAR only.
- Proof: Dart `quotation_form_test` (5), `money_input_test` (quantities); engine `engine-form-payloads` (28) covers held, approved with two lines, unknown customer, no VAT rate, wrong role. Umbrella 11794/11794.
- Next: the invoice form (below). No new engine capability was needed.

## Invoice form as built (2026-11-17)
- `InvoiceForm` behind a note-add button (key `invoices-add`) in the Invoices room, on the same `LineEditor`. On send it (1) opens a draft for the customer (POST /engine/drafts), (2) saves the lines into it (PUT /engine/drafts/:id, ZAR, date, optional reference), (3) if the engine says the draft is ready, proposes `invoice.issue` for that draft and the saved version, which is HELD; if the engine says it is not ready, its first reason is shown and nothing is proposed. A draft is a working copy and not a business fact, so steps 1 and 2 need no approval (they need `drafts.edit`, held with can_manage_invoices); nothing is issued until the owner approves step 3. A draft left behind by a refused proposal stays editable and is harmless. New app calls: `createDraft`, `saveDraft` (fixture and http).
- Proof: Dart `invoice_form_test` (6: drafts then proposal in order with exact contents, line add/remove and VAT, plain mistakes not sent, not-ready reason shown, refusal shown, the button opens it); engine `engine-form-payloads` (35) covers open, save with the engine's own totals, a draft with no date not ready, issue held, approved issuing two lines, an older version refused, a role without `drafts.edit` refused. Umbrella 11801/11801.
- Quotations and invoices now share the line editor. Not built: editing a draft later from the screen, stock items on lines (`itemId`), a currency other than rand.

## Refund form as built (2026-11-17)
- `RefundForm` behind an undo button (key `invoices-refund`) in the Invoices room. It lists the payments received that still have money left (GET /engine/credits, `payments`, no engine change; new app call `credits()` and parser `parseOverpayments`), shows how much of each is left, fills the whole amount when one is chosen, and proposes `payment.refund` {paymentId, amountMinor, refundedOn, method}, HELD. More than is left, no choice or an unclear amount is stopped on screen; the engine's reason is shown on a refusal. The engine adds its own version stamp.
- The approval screen now reads a held refund as plain lines (payment, refund amount, date, paid back by).
- Proof: Dart `refund_form_test` (8, including the parser and the held-lines reading); engine `engine-form-payloads` (41) covers the list figures the form reads, held, approved (money paid back), gone from the list once refunded in full, more than left refused, wrong role refused. Umbrella 11807/11807.
- Not built: refunding a credit note's credit (still said to the assistant), and naming the bank account a refund is paid from (the engine's refund takes no account yet).
