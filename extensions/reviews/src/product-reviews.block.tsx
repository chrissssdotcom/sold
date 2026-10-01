import ProductReviews from './product-reviews.client';

/** Page-builder renderer: the same widget, for a product chosen in the editor. */
export default function ProductReviewsBlock({ productId }: { productId: string }) {
  return <ProductReviews productId={productId} />;
}
