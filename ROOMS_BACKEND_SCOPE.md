# Rooms — Backend Scope

Pinned so this doesn't need re-investigating or re-deciding later.
Every claim below was checked directly against the real, current
`worker/src/` code and D1 schema — nothing here is assumed. Organized
by room, in the order rooms should actually get built, matching this
project's own, repeated principle: prove one room fully before
generalizing to the next, not several at once from imagined shapes.

---

## 1. People — the current, active room

**Already real, already ready — pure frontend work from here, no
backend needed:**

- `GET /debug/characters` → `id, name, relationship, created_at,
  notes` for everyone. Already what the app's People list uses.
- `GET /debug/character-facts?characterId=X` → structured, extracted
  key/value facts about that specific person.
- `GET /debug/captures?characterId=X` → the real, chronological raw
  history of every mention involving that specific person. Clean,
  already filters server-side by a real `character_id` column — no
  fuzzy text matching.

**Real, honest, still-open gap:** `/debug/characters` only ever
queries the `characters` table — personal relations (wife, nanny,
staff). It never includes `customers`. If "People" is meant to
eventually include the people you actually do business with, not just
personal relations, that's a real, separate decision to make first —
not answered by anything above.

**Genuinely new backend work, not yet built:** photos. R2 (`OFFICE_VAULT`)
already stores photos, and they already flow through the same
capture/extraction pipeline as text (a photo's `captures` row can get
a real `character_id`, same mechanism as everything else) — but
there's no dedicated "this is a profile picture" or "this is an
installation portfolio" concept anywhere in the schema. A photo
linked to a person today is just "a capture that happens to be a
photo, that happens to mention this person" — not a purpose-built
profile/portfolio field. Real work if this is wanted: likely a new
column or small table distinguishing photo *role* (profile vs.
portfolio vs. incidental), not just presence.

## 2. Suppliers — the natural second room

**Already real and substantial — genuinely rich, not a stretch:**
`purchase_orders`, `po_line_items`, `goods_received_notes`,
`grn_line_items`, `supplier_invoices`, `supplier_invoice_line_items`,
`supplier_payments`. This is the proven supplier-statement-
reconciliation work — real, tested, working.

**Real, honest gap:** no `/debug`-style read endpoint confirmed yet
for pulling a single supplier's purchase history the way
`/debug/captures?characterId=X` does for a person. The data exists;
a clean, filtered read route to expose it to a room doesn't yet, or
hasn't been confirmed to. Check before assuming it's a pure frontend
task the way People turned out to be.

## 3. Inventory / Products — named, but genuinely further out

**Not real yet — checked directly, not assumed:** `stock_items`
tracks `name, unit, quantity_on_hand, reorder_threshold`. No price
field at all. "Product lists, pricing" as described would be real,
new backend work — a genuinely different task than the retrieval
work everything above turned out to be, since the data itself
doesn't exist yet, not just an unexposed read route.

---

## The real, deliberate sequencing decision

Build People fully first, with what's already confirmed real for it
(relationship, facts, history — no backend work needed). Only once
that's genuinely proven should Suppliers become the second real room
— giving the eventual multi-room pattern two real, built examples to
generalize from honestly, rather than guessing at three or four room
shapes at once from imagination. Inventory/products stays named and
scoped here, explicitly not started, until its own real backend work
(a genuine product/pricing concept) is separately decided worth
building.
