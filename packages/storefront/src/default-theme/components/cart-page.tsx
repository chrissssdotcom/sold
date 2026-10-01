'use client';

import Link from 'next/link';
import { useState } from 'react';
import { formatMoney } from '../../kit/money';
import { useCart } from '../../kit/cart-provider';
import { Arrow, Bag, Close, Minus, Plus } from '../../kit/icons';

export function CartPage({ tag, base }: { tag: string; base: string }) {
  const cart = useCart();
  const [code, setCode] = useState('');

  if (!cart.loaded)
    return (
      <div className="panel" aria-busy="true">
        <p className="muted">Loading your bag…</p>
      </div>
    );

  if (cart.items.length === 0)
    return (
      <div className="empty-state">
        <div className="drawer__empty-art" aria-hidden="true">
          <Bag width={44} height={44} />
        </div>
        <h2 className="h-section" style={{ marginTop: 0 }}>
          Your bag is empty
        </h2>
        <p className="lede">Nothing here yet. The good stuff is one click away.</p>
        <Link href={`${base}/products`} className="btn btn--primary btn--lg">
          Start shopping <Arrow width={20} height={20} />
        </Link>
      </div>
    );

  return (
    <div className="two-col">
      <section className="panel" aria-label="Items in your bag">
        {cart.error ? (
          <p className="alert" role="alert" style={{ margin: '0 0 1rem' }}>
            {cart.error}
          </p>
        ) : null}
        <ul aria-busy={cart.busy}>
          {cart.items.map((item) => (
            <li
              key={item.variantId}
              className="line"
              style={{ gridTemplateColumns: '6.5rem 1fr auto' }}
            >
              <Link
                href={`${base}/products/${item.handle}`}
                className="line__media"
                tabIndex={-1}
                aria-hidden="true"
              >
                {item.image ? <img src={item.image} alt="" width={104} height={130} /> : null}
              </Link>
              <div className="line__body">
                <Link href={`${base}/products/${item.handle}`} className="line__title">
                  {item.title}
                </Link>
                <div className="line__price">{formatMoney(item.unitPrice, tag)} each</div>
                <div
                  style={{
                    display: 'flex',
                    gap: '1rem',
                    alignItems: 'center',
                    marginTop: '0.4rem',
                  }}
                >
                  <div className="stepper" role="group" aria-label={`Quantity of ${item.title}`}>
                    <button
                      type="button"
                      aria-label="Decrease quantity"
                      onClick={() => void cart.setQuantity(item.variantId, item.quantity - 1)}
                      disabled={cart.busy}
                    >
                      <Minus width={16} height={16} />
                    </button>
                    <output aria-live="polite">{item.quantity}</output>
                    <button
                      type="button"
                      aria-label="Increase quantity"
                      onClick={() => void cart.setQuantity(item.variantId, item.quantity + 1)}
                      disabled={cart.busy}
                    >
                      <Plus width={16} height={16} />
                    </button>
                  </div>
                  <button
                    type="button"
                    className="link muted"
                    onClick={() => void cart.setQuantity(item.variantId, 0)}
                    disabled={cart.busy}
                  >
                    Remove
                  </button>
                </div>
              </div>
              <div className="line__total">
                <strong>{formatMoney(item.lineTotal, tag)}</strong>
              </div>
            </li>
          ))}
        </ul>
      </section>

      <aside className="summary panel" aria-label="Order summary">
        <h2 style={{ marginBottom: 0 }}>Summary</h2>
        <form
          className="coupon"
          onSubmit={async (e) => {
            e.preventDefault();
            if (code.trim() && (await cart.applyCoupon(code.trim()))) setCode('');
          }}
        >
          <label htmlFor="cart-coupon" className="visually-hidden">
            Discount code
          </label>
          <input
            id="cart-coupon"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="Discount code"
            autoComplete="off"
          />
          <button
            type="submit"
            className="btn btn--ghost btn--sm"
            disabled={cart.busy || !code.trim()}
          >
            Apply
          </button>
        </form>
        {cart.estimate?.rejectedCoupons.map((r) => (
          <p key={r.code} className="coupon__msg" role="status">
            Code “{r.code}” can’t be used ({r.reason.replaceAll('_', ' ')}).{' '}
            <button type="button" className="link" onClick={() => void cart.removeCoupon(r.code)}>
              Remove
            </button>
          </p>
        ))}
        {cart.estimate ? (
          <>
            <div className="sum">
              <span>Items</span>
              <span>{formatMoney(cart.estimate.subtotal, tag)}</span>
            </div>
            {cart.estimate.discounts.map((d) => (
              <div key={d.name} className="sum sum--discount">
                <span>
                  {d.name}
                  {d.code ? (
                    <button
                      type="button"
                      className="chip"
                      onClick={() => void cart.removeCoupon(d.code!)}
                      aria-label={`Remove code ${d.code}`}
                    >
                      {d.code} <Close width={12} height={12} />
                    </button>
                  ) : null}
                </span>
                <span>−{formatMoney(d.amount, tag)}</span>
              </div>
            ))}
            <div className="sum sum--total">
              <span>Subtotal</span>
              <strong>{formatMoney(cart.estimate.net, tag)}</strong>
            </div>
          </>
        ) : null}
        <p className="muted small">Shipping and taxes are calculated at checkout.</p>
        <Link href={`${base}/checkout`} className="btn btn--primary btn--lg btn--block">
          Checkout <Arrow width={20} height={20} />
        </Link>
        <Link href={`${base}/products`} className="link center">
          Continue shopping
        </Link>
      </aside>
    </div>
  );
}
