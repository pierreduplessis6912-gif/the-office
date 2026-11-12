# The model as an interpreter: the stock capabilities (2026-11-11)

**Status:** DESIGN, written before the code (tests first). Extends `interpreter-stack.md`. Defaults below are open to Pierre; nothing here has been run with a real model, and the real run is held until he says "run it".

## What stays exactly as it is
The model is shown only the capabilities this business has and this member may use, and the sentence (never business data). It supplies WORDS and plain numbers, never an id, a date, a rate or a reason; the engine resolves names, works out dates and builds the payload. A write is only PROPOSED and HELD: a person approves it, and the model can never approve. Anything outside the catalogue, with an argument it was not given, or malformed is NOT UNDERSTOOD: said honestly, with only a capture and an observation written.

## What the model is offered (seven entries)
**Reads** (permission `stock.read`, `price.read` for prices):
1. `stock.on_hand` {item?}: how much of an item is in stock (all stock when no item is named).
2. `stock.reorder_suggestions` {}: what needs to be reordered.
3. `prices.find` {item}: what an item sells for.

**Writes** (proposed and held; `stock.move`, so field staff with the materials capability may ask, and a money role approves):
4. `stock.issue` {item, quantity, job?, location?}: take stock out for a job or for use.
5. `stock.transfer` {item, quantity, from, to}: move stock between places.
6. `stock.count` {item, counted, location?}: record what was counted of an item at a place (the engine works out and shows the variance; counted may be 0).
7. `stock.reserve` {item, quantity, job}: set stock aside for a job.

## How the engine resolves and builds
- **Quantity** is a plain number of the item's own units (3, 2.5). The engine turns it into thousandths and refuses anything that is not a positive number of at most three decimals and at most 1,000,000 (`counted` may be 0). A sentence that gives no number is not understood.
- **Item** is resolved from the words by the engine (exact name or code first, then a single match); several matches come back as a list to choose from, none is `not_found` ("There is no stock item called X"). Inactive items are not offered.
- **Location** is resolved by name. If none is named: the only place the business has, else the only place that holds that item, else the engine asks "Which location?" and lists them (nothing is held). A name that matches no place is `not_found`.
- **Reason and job:** an issue with a job named is reason `job` with the job as its reference; without one it is reason `use`. A reservation's job is its reference.
- **Dates** are always today, from the engine's clock. The model cannot supply one.

## Deliberately NOT offered to the model, and why
- `stock.receive`: a cost per unit (and whether it includes VAT) cannot be assumed from a sentence; deliveries go in from the goods receipt (`stock.receive_delivery`) which carries the order's own price.
- `stock.adjust`, `stock.write_down`, `stock.return`, `stock.reverse`, `item.price`: they need a reason, evidence, a money figure or a judgement; a person does them in the app or through the engine.
- `item.create`, `location.create`: master data (a code and a unit are decisions), not something to infer from a sentence.
- `stock.release`: it needs a reservation number, which a sentence does not carry.

## Left open
Whether `stock.receive` should be offered with a cost and an explicit VAT word, as `expense.record` does; whether "yesterday" should be allowed for a stock movement; speech-to-text slips on item names (the engine resolves by words, so a close misspelling is a list or `not_found`, never a guess).
