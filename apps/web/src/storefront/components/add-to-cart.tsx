'use client';

import { useState } from 'react';
import { useCart } from './cart-provider';
import { Bag, Check, Minus, Plus } from './icons';

export function AddToCart({
  variantId,
  label,
  disabled,
  max,
  withQuantity = true,
}: {
  variantId: string;
  label: string;
  disabled?: boolean;
  max?: number | null;
  withQuantity?: boolean;
}) {
  const cart = useCart();
  const [qty, setQty] = useState(1);
  const [done, setDone] = useState(false);
  const cap = Math.min(max ?? 99, 99);

  return (
    <div className="buy">
      {withQuantity ? (
        <div className="stepper stepper--lg" role="group" aria-label="Quantity">
          <button
            type="button"
            onClick={() => setQty((q) => Math.max(1, q - 1))}
            aria-label="Decrease quantity"
            disabled={qty <= 1}
          >
            <Minus width={18} height={18} />
          </button>
          <output aria-live="polite">{qty}</output>
          <button
            type="button"
            onClick={() => setQty((q) => Math.min(cap, q + 1))}
            aria-label="Increase quantity"
            disabled={qty >= cap}
          >
            <Plus width={18} height={18} />
          </button>
        </div>
      ) : null}
      <button
        type="button"
        className="btn btn--primary btn--lg buy__btn"
        disabled={disabled || cart.busy}
        onClick={async () => {
          const ok = await cart.add(variantId, qty, label);
          if (ok) {
            setDone(true);
            setTimeout(() => setDone(false), 1800);
          }
        }}
      >
        {done ? <Check width={20} height={20} /> : <Bag width={20} height={20} />}
        {disabled ? 'Sold out' : done ? 'Added' : 'Add to bag'}
      </button>
    </div>
  );
}

/** One-tap add for product cards (single-variant products). */
export function QuickAdd({ variantId, label }: { variantId: string; label: string }) {
  const cart = useCart();
  return (
    <button
      type="button"
      className="quick-add"
      disabled={cart.busy}
      onClick={() => void cart.add(variantId, 1, label)}
      aria-label={`Add ${label} to bag`}
    >
      <Plus width={18} height={18} /> <span>Quick add</span>
    </button>
  );
}
