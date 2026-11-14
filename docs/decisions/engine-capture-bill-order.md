# Engine capture: a supplier bill photo is linked to its purchase order — 2026-11-14

Status: built on Pierre's word ("Do all 3", 2026-11-14). Extends `engine-capture-bill.md` (its stated limit "not linked to an order" is lifted by this note). No deploy, no real-model run.

## Decision
- The model may supply ONE more word: OUR purchase order number, a plain whole number, only if the bill shows it (`orderNumber`). Not a number, zero, negative, a fraction or absurd: NOT UNDERSTOOD.
- The ENGINE finds the order: that supplier's, with that number, not cancelled. Exactly one found: the bill is linked (`orderId`).
- Lines: a bill line is linked to an order line (`orderLineNo`) only when its description, ignoring case and extra spaces, equals exactly ONE order line's description. Otherwise it stays unlinked and the engine's three-way match shows it as not on the order. Nothing is guessed.
- The three-way match (price, tax rate, quantity against what was received) is the engine's own, unchanged: the approver sees `matched` or `variance` before approving. Nothing is recorded until a person approves.
- A number that is not found, is another supplier's, or is cancelled: the bill is still held, WITHOUT an order, and the answer says "Order N was not found with <supplier>, so this bill is held without an order." Never silently dropped, never refused for it.

## Not built
- Matching by description similarity, by item or by amount; offering a choice of orders. Receiving goods from the bill.
