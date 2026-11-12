> **Status:** design (2026-11-11), written on Pierre's instruction: "we have to look at stock holistically as it touches procurement, sales, costing etc." **Decided by Pierre 2026-11-11:** the 2026-11-01 restore-drill gate is **waived for now** for additive engine tables on the branch. I took that as **option A** (additive tables; `docs/decisions/inventory.md` section 3), since waiving the drills only matters for a schema change; **say so if that is wrong.** **Owns:** how stock connects to every other domain, the one mechanism that carries an item through a document line, how cost flows end to end, and the order the connections are built in. `docs/decisions/inventory.md` still owns what stock is and its invariants. Built so far: increment 1 of section 6 (the ledger foundation), engine and CI only.

# Stock, holistically

## 1. The business as one chain (what exists, and where stock plugs in)
```
 BUY                                                         SELL
 quotation (supplier) ... purchase_order.create               quotation.create ── price list (item selling price)
        │ lines may name an ITEM                                   │ lines may name an ITEM; stock.reserve (soft hold)
        ▼                                                          ▼
 goods.receive (what arrived)  ──► stock.receive (what went INTO a location, at cost)       invoice (what we billed)
        │                                  │  cost = the order line's price                      │ lines name an ITEM
        ▼                                  ▼                                                     ▼
 supplier_invoice.record (3-way match) ─► cost adjustment (accepted price variance, freight)   stock.issue (what LEFT, cost stamped)
        │                                                                                         │ cost of sales per invoice line
        ▼                                                                                         ▼
 supplier_payment.record                                                                  margin per line, per invoice, per job
        └─ VAT input tax (unchanged: from bills and expenses)                       credit_note.issue ─► stock.return (back at the ORIGINAL cost) or write-off
 COUNT / ADJUST / WRITE-DOWN ── (stocktake, damage, obsolescence) ── valuation as at a date ── s22 closing stock
 JOBS (later) ── stock issued to a job is that job's material cost ── installer vans are locations
```
Every arrow on the chain already has an engine capability except the ones touching stock (`stock.*`) and a **price list**; the work is to add those and the small, additive hooks that tie the two halves together.

## 2. The one mechanism that carries an item through a document: `lineItems`
Document lines (`eng_document_line`) have **no item column, and the foundation tables never change shape** (the STOP RULE). So a document names the item each line is for in its own **`terms.lineItems`: `[{lineNo, itemId}]`**, written at creation, immutable with the document, validated at the door (the item exists, is active, and the line's unit matches the item's unit). It is an **optional, additive field** on `purchase_order.create`, `quotation.create`, `quotation.revise`, `invoice.issue`, `credit_note.issue` and `supplier_invoice.record`: a line with no `itemId` is a service, a note or a one-off, exactly as today, so nothing already built changes behaviour. Stock movements point back the other way with `source_document_id` and `source_line_no`, so any line can be followed to the stock it moved and any movement to the line that caused it.

## 3. What each domain gives to stock and gets from it
| Domain | Gives stock | Gets from stock | Built in |
| --- | --- | --- | --- |
| **Procurement (orders, receipts)** | The item on each order line; the goods-receipt line is the proof of what arrived and its price is the receipt cost | "Stocked" joins "ordered" and "received" on the order: an order line is complete when received AND put into stock; a **goods-received-not-invoiced** report (received value less billed value) | Increment 3 |
| **Procurement (bills, three-way match)** | The bill's accepted price variance and its freight or duty lines become a **cost adjustment** on the stock they relate to (landed cost), traceable to the bill | The bill's price is checked against the cost the stock was received at | Increment 3 (price variance), later (landed cost allocation) |
| **Supplier returns and credit notes (not built)** | A supplier credit for goods sent back | A `stock.issue` of reason "returned to supplier" at the cost it was received at | After procurement credit notes exist |
| **Sales (quotations)** | The item and quantity quoted | `available` (on hand less reserved) shown at quoting; the price list supplies the unit price; `stock.reserve` holds stock for an accepted quote | Increments 2 and 4 |
| **Sales (invoices)** | The item on each invoice line | `stock.issue` for the invoice: **cost of sales per line**, so margin per line and per invoice; **invoicing never blocks on stock** (flooring is often ordered after the quote), **fulfilment does**: an invoice line can be invoiced but unfulfilled, and the shortfall is a visible backorder | Increment 4 |
| **Sales (credit notes, returns)** | The credited item and quantity | `stock.return`: back into stock at the **original** cost (read from the issue it reverses), or written off if damaged | Increment 4 |
| **Costing and margin** | Cost of every issue (stamped at posting) | Per invoice line, per invoice, per item, per job; the stock value; the cost of goods sold for a period | Increments 1, 3, 4 |
| **Tax (VAT)** | Nothing: stock moves carry **no VAT**; input tax stays on the bill or expense that carried it | Nothing | n/a |
| **Tax (income tax s22)** | Write-downs with reason and evidence | Closing stock valuation as at a date (cost less recorded diminution) | Increment 3 |
| **Jobs (later row)** | The job a movement is for | Material cost of a job; installer vans as locations; materials a job needs against what is available | Jobs row |
| **Finance / general ledger (later)** | A chart of accounts | Postings: inventory asset, cost of sales, goods received not invoiced. **Until a ledger exists the engine REPORTS value and cost, it does not post** | Later |
| **Conversation, MCP, app** | Sentences and screens | "Issue three sheets to the Mokoena job"; low-stock suggestions; a count on a phone | Increment 5 |

## 4. Cost: one story from the supplier's price to the margin on an invoice line
1. **Receipt cost** = the unit price of the order line the goods arrived on (net of VAT: VAT is recoverable and never part of stock cost for a VAT-registered business), unless a person gives a different cost for a by-hand receipt.
2. **Weighted average, company-wide per item**: value on hand divided by quantity on hand, recomputed from the movements. FIFO is added later as a business policy, chosen once (increment 3); LIFO is never offered (IAS 2).
3. **Cost stamped when a movement is recorded, never after**: an issue carries the average at that moment; back-dating or a later correction can never rewrite past cost of sales. The movement stores its own **value**, so zero quantity means exactly zero value (no residue).
4. **Adjustments are movements**: a count difference, damage or a write-down is recorded with a reason; a bill's accepted price variance is a **cost adjustment** movement against the item, linked to the bill.
5. **Cost of sales per invoice line** = the value of the issue movements that point at that line; **margin** = line net price less that cost; a **job's material cost** = the issues pointing at the job. Landed cost (freight and duty) is allocated to the stock it relates to in a later increment; until then it stays on the bill as an expense-like line.
6. **Stock value is cost, never selling price**, and is reported by item, by location and as at a date.

## 5. Invariants that cross domains (each a test and a verifier check, built with the link that needs it)
- **Quantity conservation along the chain:** for every order line, stocked ≤ received ≤ ordered; billed ≤ received (already enforced by the match); for every invoice line, issued ≤ invoiced.
- **Cost conservation:** stock value = the value of every receipt and cost adjustment, less the value of every issue, write-off and count loss; the verifier recomputes it from the movements and reports any difference.
- **A movement always has a cause:** a goods-receipt line, an invoice line, a count, an adjustment reason, a job or a transfer pair; one with no cause is refused.
- **No hidden edits across the chain:** receiving, billing, stocking and issuing never edit an order, a receipt, a bill or an invoice; the link is a new fact.
- **Reservations never exceed what exists:** reserved ≤ on hand per item and location; a reservation is released when its quote lapses or is declined (derived, not forgotten).

## 6. Order of work (each step: decisions, tests first, deliberate breakages, then engine, MCP and recovery; the app and staging on Pierre's word)
1. **Ledger foundation** (the additive tables, items, locations, receive, issue, transfer, adjust, reverse, the reads, the verifier, recovery). Designed so every later link is additive: movements already carry `source_document_id`, `source_line_no`, a `reason` and a `job_ref`.
2. **Control:** counts, reservations, reorder suggestions.
3. **Procurement link:** `lineItems` on orders and bills; `stock.receive` from a goods-receipt line (stocked ≤ received); the goods-received-not-invoiced report; the cost adjustment for an accepted price variance; stocked shown on the order.
4. **Sales link:** the price list; `lineItems` on quotations, invoices and credit notes; reservations from quotes; `stock.issue` for an invoice line; `stock.return`; margin per line.
5. **Valuation and tax:** write-downs with evidence, FIFO option, closing-stock valuation as at a date, stock-to-ledger reconciliation.
6. **Traceability and units:** lots, serials, unit conversions, remnants.
7. **Reach:** interpreter, staging proofs, MCP hints, app.

## 7. Decided here (defaults; open to Pierre)
Items and locations are separate masters; the movement ledger is one table; `lineItems` is how a document names an item; invoicing never blocks on stock; fulfilment is a separate, explained act; cost is weighted average first; stock moves carry no VAT; the engine reports valuation and cost but does not post to a ledger; the person on site may propose a movement and a money role approves it (as for goods received).

## 8. Risks this design is meant to avoid (each came from a real pattern in the ERP research)
Stock that can go negative; cost that quietly changes when something is back-dated; an invoice that cannot be issued because the shelf is empty; stock received that nobody can tie to an order or a bill; a count that overwrites rather than explains; valuation that cannot be reconciled; a design that fits purchasing but not selling, or the reverse.
