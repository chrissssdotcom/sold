# reviews

Verified-buyer product reviews with moderation.

- **Who can review:** a signed-in customer with a paid (not pending or cancelled) order containing the product. Checked against Base's order tables (read-only).
- **One review per customer per product.** Editing replaces it and sends it back through moderation (unless `autoApprove` is on).
- **Moderation:** console > Marketing > Review moderation (permission `reviews.moderate`, grantable to a role). New reviews are `pending` by default.
- **Storefront:** a widget under the buy box on every product page (slot `product.detail.aside`) and a page-builder block `reviews/product-reviews`. Text is stored as text and rendered escaped.
- **API:** `GET /x/reviews/products/:productId/reviews` (public, cached 60 s, keyset-paginated), `POST` the same path (customers), `GET /admin/x/reviews/queue`,
  `POST /admin/x/reviews/reviews/:id/moderate` (staff).

## Known limits

- The widget loads client-side, so review text and star ratings are **not in the server-rendered HTML and are not seen by crawlers that do not run JavaScript**. There is also no
  `aggregateRating` in the product's JSON-LD (an extension cannot contribute to Base's structured data yet).
- Display name is whatever the customer types (60 chars, plain text); accounts have no separate public display name.
- No review photos, replies, helpful votes, or abuse reporting. No email asking for a review yet (lifecycle automation).
- Moderation is manual; there is no spam scoring beyond verified-buyer, one-per-product and length limits.

Tests: `src/reviews.test.ts` (validation), and `apps/web/e2e/reviews.e2e.ts` (verified-buyer rule, moderation, edit resets moderation, visibility, product page and admin screen in a browser with axe).
