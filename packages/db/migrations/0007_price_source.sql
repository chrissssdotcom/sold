-- Distinguish hand-set prices from ones derived from the base currency by FX, so a rate refresh
-- never overwrites a price an operator set on purpose.
ALTER TABLE variant_prices ADD COLUMN source text NOT NULL DEFAULT 'manual';
--> statement-breakpoint

ALTER TABLE variant_prices ADD CONSTRAINT variant_prices_source_check CHECK (source IN ('manual', 'derived')) NOT VALID;
--> statement-breakpoint

ALTER TABLE variant_prices VALIDATE CONSTRAINT variant_prices_source_check;
