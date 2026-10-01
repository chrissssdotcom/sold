-- Product reviews. Namespaced ext_reviews_*: this extension never writes Base tables.
-- product_id / customer_id / order_id are plain text (not foreign keys) so reviews survive catalogue and account changes.

CREATE TABLE ext_reviews_reviews (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id   text NOT NULL,
  customer_id  text NOT NULL,
  rating       smallint NOT NULL CHECK (rating BETWEEN 1 AND 5),
  title        text NOT NULL DEFAULT '' CHECK (char_length(title) <= 120),
  body         text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 4000),
  author_name  text NOT NULL DEFAULT 'Verified buyer' CHECK (char_length(author_name) <= 60),
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  moderated_at timestamptz,
  moderated_by text,
  -- One review per customer per product: editing replaces it (and sends it back through moderation).
  CONSTRAINT ext_reviews_reviews_one_per_customer UNIQUE (product_id, customer_id)
);
--> statement-breakpoint

-- The storefront list and summary read approved reviews for one product, newest first.
CREATE INDEX ext_reviews_reviews_product_idx ON ext_reviews_reviews (product_id, created_at DESC, id DESC) WHERE status = 'approved';
--> statement-breakpoint

-- The moderation queue.
CREATE INDEX ext_reviews_reviews_pending_idx ON ext_reviews_reviews (created_at) WHERE status = 'pending';
