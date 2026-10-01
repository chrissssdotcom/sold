-- The customer's cookie-consent choice at the moment the order was placed. Recorded with the order (not looked up later)
-- so server-side marketing events can honour what the customer actually agreed to, and so the record is auditable.
-- Shape: {"analytics": boolean, "marketing": boolean}. Defaults to nothing consented.
ALTER TABLE orders ADD COLUMN consent jsonb NOT NULL DEFAULT '{"analytics": false, "marketing": false}'::jsonb;
