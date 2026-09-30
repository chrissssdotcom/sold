'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { formatMoney } from '../lib/money';
import { useCart } from './cart-provider';
import { Arrow, Bag, Close, Minus, Plus } from './icons';

export function CartButton({ label }: { label: string }) {
  const cart = useCart();
  return (
    <button
      type="button"
      className="icon-btn cart-btn"
      onClick={cart.openCart}
      aria-label={`${label}, ${cart.count} item${cart.count === 1 ? '' : 's'}`}
    >
      <Bag />
      {cart.count > 0 ? (
        <span className="cart-btn__count" aria-hidden="true" key={cart.count}>
          {cart.count}
        </span>
      ) : null}
    </button>
  );
}

export function CartDrawer({ tag, base }: { tag: string; base: string }) {
  const cart = useCart();
  const ref = useRef<HTMLDialogElement>(null);
  const [code, setCode] = useState('');

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (cart.open && !d.open) d.showModal();
    if (!cart.open && d.open) d.close();
  }, [cart.open]);

  const empty = cart.loaded && cart.items.length === 0;

  return (
    <dialog
      ref={ref}
      className="drawer"
      aria-labelledby="drawer-title"
      onCancel={(e) => {
        e.preventDefault();
        cart.closeCart();
      }}
      onClick={(e) => {
        if (e.target === ref.current) cart.closeCart();
      }}
    >
      <div className="drawer__panel">
        <header className="drawer__head">
          <h2 id="drawer-title" className="drawer__title">
            Your bag{' '}
            <span className="drawer__count">{cart.count > 0 ? `(${cart.count})` : ''}</span>
          </h2>
          <button
            type="button"
            className="icon-btn"
            onClick={cart.closeCart}
            aria-label="Close bag"
          >
            <Close />
          </button>
        </header>

        <p className="visually-hidden" role="status" aria-live="polite">
          {cart.notice ?? ''}
        </p>
        {cart.error ? (
          <p className="alert" role="alert">
            {cart.error}
          </p>
        ) : null}

        {empty ? (
          <div className="drawer__empty">
            <div className="drawer__empty-art" aria-hidden="true">
              <Bag width={44} height={44} />
            </div>
            <p className="drawer__empty-title">Your bag is empty</p>
            <p className="muted">Find something you will love and it will wait for you here.</p>
            <Link href={`${base}/products`} className="btn btn--primary" onClick={cart.closeCart}>
              Shop everything <Arrow width={18} height={18} />
            </Link>
          </div>
        ) : (
          <>
            <ul className="drawer__items" aria-busy={cart.busy}>
              {cart.items.map((item) => (
                <li key={item.variantId} className="line">
                  <Link
                    href={`${base}/products/${item.handle}`}
                    className="line__media"
                    onClick={cart.closeCart}
                    tabIndex={-1}
                    aria-hidden="true"
                  >
                    {item.image ? <img src={item.image} alt="" width={96} height={120} /> : null}
                  </Link>
                  <div className="line__body">
                    <Link
                      href={`${base}/products/${item.handle}`}
                      className="line__title"
                      onClick={cart.closeCart}
                    >
                      {item.title}
                    </Link>
                    <div className="line__price">{formatMoney(item.unitPrice, tag)}</div>
                    <div className="stepper" role="group" aria-label={`Quantity of ${item.title}`}>
                      <button
                        type="button"
                        onClick={() => void cart.setQuantity(item.variantId, item.quantity - 1)}
                        aria-label={
                          item.quantity === 1 ? `Remove ${item.title}` : 'Decrease quantity'
                        }
                        disabled={cart.busy}
                      >
                        <Minus width={16} height={16} />
                      </button>
                      <output aria-live="polite">{item.quantity}</output>
                      <button
                        type="button"
                        onClick={() => void cart.setQuantity(item.variantId, item.quantity + 1)}
                        aria-label="Increase quantity"
                        disabled={cart.busy}
                      >
                        <Plus width={16} height={16} />
                      </button>
                    </div>
                  </div>
                  <div className="line__total">
                    {BigInt(item.discount.amount) > 0n ? (
                      <s className="muted">
                        {formatMoney(
                          {
                            amount: (
                              BigInt(item.lineTotal.amount) + BigInt(item.discount.amount)
                            ).toString(),
                            currency: item.lineTotal.currency,
                          },
                          tag,
                        )}
                      </s>
                    ) : null}
                    <strong>{formatMoney(item.lineTotal, tag)}</strong>
                  </div>
                </li>
              ))}
            </ul>

            <div className="drawer__foot">
              <form
                className="coupon"
                onSubmit={async (e) => {
                  e.preventDefault();
                  if (code.trim() && (await cart.applyCoupon(code.trim()))) setCode('');
                }}
              >
                <label htmlFor="coupon" className="visually-hidden">
                  Discount code
                </label>
                <input
                  id="coupon"
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
                  <button
                    type="button"
                    className="link"
                    onClick={() => void cart.removeCoupon(r.code)}
                  >
                    Remove
                  </button>
                </p>
              ))}
              {cart.estimate?.discounts.map((d) => (
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
                <strong>{cart.estimate ? formatMoney(cart.estimate.net, tag) : '—'}</strong>
              </div>
              <p className="muted small">Shipping and taxes are calculated at checkout.</p>
              <Link
                href={`${base}/checkout`}
                className="btn btn--primary btn--block"
                onClick={cart.closeCart}
              >
                Checkout <Arrow width={18} height={18} />
              </Link>
              <Link href={`${base}/cart`} className="link center" onClick={cart.closeCart}>
                View full bag
              </Link>
            </div>
          </>
        )}
      </div>
    </dialog>
  );
}
