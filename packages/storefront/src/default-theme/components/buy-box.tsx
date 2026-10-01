'use client';

import { useId, useState } from 'react';
import type { MoneyJson } from '../../kit/money';
import { AddToCart } from './add-to-cart';
import { Price } from '../../kit/price';

export interface BuyVariant {
  id: string;
  title: string;
  price: MoneyJson | null;
  compareAt: MoneyJson | null;
  /** null = backorderable (unlimited). */
  available: number | null;
}

export function BuyBox({
  variants,
  tag,
  productTitle,
}: {
  variants: BuyVariant[];
  tag: string;
  productTitle: string;
}) {
  const firstInStock = variants.find((v) => v.available !== 0) ?? variants[0];
  const [selected, setSelected] = useState(firstInStock?.id ?? '');
  const name = useId();
  const v = variants.find((x) => x.id === selected) ?? variants[0];
  if (!v) return null;
  const out = v.available === 0;
  const low = v.available !== null && v.available > 0 && v.available <= 5;
  const multi = variants.length > 1;
  return (
    <div className="stack" style={{ ['--stack' as string]: '1.5rem' }}>
      {v.price ? (
        <Price price={v.price} compareAt={v.compareAt} tag={tag} size="lg" />
      ) : (
        <p className="notice">This item is not sold in your region’s currency yet.</p>
      )}

      {multi ? (
        <fieldset className="options" style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="label">Choose a style</legend>
          <div className="options__list">
            {variants.map((x) => (
              <label key={x.id} className="option">
                <input
                  type="radio"
                  name={name}
                  value={x.id}
                  checked={x.id === selected}
                  disabled={x.available === 0}
                  onChange={() => setSelected(x.id)}
                />
                <span>{x.title || 'Standard'}</span>
              </label>
            ))}
          </div>
        </fieldset>
      ) : null}

      <p className={`stock${out ? ' stock--out' : low ? ' stock--low' : ''}`} role="status">
        {out ? 'Sold out' : low ? `Only ${v.available} left` : 'In stock, ships in 1–2 days'}
      </p>

      <AddToCart
        key={v.id}
        variantId={v.id}
        label={productTitle}
        disabled={out || !v.price}
        max={v.available}
      />
    </div>
  );
}
