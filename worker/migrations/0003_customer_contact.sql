-- A customer's phone number and email as real columns (2026-10-27). Until now a stated phone number or email was saved only as a loose note in customer_facts, which no screen or report reads, so it was kept but never shown (found by Pierre: "phone numbers are not stored in the customer profile"). The Office's own rule for a fact that earns a real column (memory.ts applyStructuredFact) is a deliberate migration: this is it.
-- Additive only: two new columns, then each customer gets the LATEST phone number and email already noted for them (a backfill that never overwrites a value that is already there).
ALTER TABLE customers ADD COLUMN phone TEXT;
ALTER TABLE customers ADD COLUMN email TEXT;
UPDATE customers SET phone = (SELECT f.value FROM customer_facts f WHERE f.customer_id = customers.id AND f.key = 'phone_number' ORDER BY f.id DESC LIMIT 1) WHERE phone IS NULL;
UPDATE customers SET email = (SELECT f.value FROM customer_facts f WHERE f.customer_id = customers.id AND f.key = 'email' ORDER BY f.id DESC LIMIT 1) WHERE email IS NULL;
