'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { formatMoney, type MoneyJson } from '../lib/money';
import { useCart } from './cart-provider';
import { Arrow, Bag } from './icons';

const COUNTRIES = [
  ['AU', 'Australia'],
  ['NZ', 'New Zealand'],
  ['US', 'United States'],
  ['GB', 'United Kingdom'],
  ['CA', 'Canada'],
  ['IE', 'Ireland'],
  ['SG', 'Singapore'],
  ['JP', 'Japan'],
  ['DE', 'Germany'],
  ['FR', 'France'],
] as const;

interface ShippingOption {
  methodId: string;
  label: string;
  amount: MoneyJson;
  estimatedDaysMin: number;
  estimatedDaysMax: number;
}
interface QuoteView {
  shippingOptions: ShippingOption[];
  selectedShipping: string | null;
  subtotal: MoneyJson;
  discountTotal: MoneyJson;
  shippingTotal: MoneyJson;
  taxTotal: MoneyJson;
  total: MoneyJson;
  pricesIncludeTax: boolean;
}
interface Gateway {
  id: string;
  displayName: string;
}
interface ApiError {
  error?: {
    code?: string;
    message?: string;
    details?: { issues?: { path: string; message: string }[] };
  };
}

const EMPTY = {
  email: '',
  name: '',
  line1: '',
  line2: '',
  city: '',
  region: '',
  postalCode: '',
  country: 'AU',
};
type Form = typeof EMPTY;

const REQUIRED: (keyof Form)[] = ['email', 'name', 'line1', 'city', 'postalCode', 'country'];
const LABELS: Record<string, string> = {
  email: 'Email',
  name: 'Full name',
  line1: 'Address',
  city: 'City',
  postalCode: 'Postcode',
  country: 'Country',
};

async function post<T>(
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ ok: boolean; status: number; data: T & ApiError }> {
  const res = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return {
    ok: res.ok,
    status: res.status,
    data: (await res.json().catch(() => ({}))) as T & ApiError,
  };
}

export function CheckoutForm({
  tag,
  base,
  currency,
}: {
  tag: string;
  base: string;
  currency: string;
}) {
  const cart = useCart();
  const router = useRouter();
  const [form, setForm] = useState<Form>(EMPTY);
  const [touched, setTouched] = useState<Partial<Record<keyof Form, boolean>>>({});
  const [quote, setQuote] = useState<QuoteView | null>(null);
  const [method, setMethod] = useState<string>('');
  const [gateways, setGateways] = useState<Gateway[]>([]);
  const [gateway, setGateway] = useState('');
  const [quoting, setQuoting] = useState(false);
  const [placing, setPlacing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const idem = useRef<string>('');

  const errors = useMemo(() => {
    const e: Partial<Record<keyof Form, string>> = {};
    for (const k of REQUIRED) if (!form[k].trim()) e[k] = `${LABELS[k]} is required`;
    if (form.email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(form.email))
      e.email = 'Enter a valid email address';
    return e;
  }, [form]);
  const addressReady = !errors.line1 && !errors.city && !errors.postalCode && !errors.country;

  useEffect(() => {
    void fetch(`/api/checkout/gateways?currency=${currency}`, { credentials: 'same-origin' })
      .then((r) => r.json())
      .then((d: { gateways?: Gateway[] }) => {
        setGateways(d.gateways ?? []);
        setGateway((g) => g || d.gateways?.[0]?.id || '');
      })
      .catch(() => undefined);
  }, [currency]);

  // Re-quote when the address or chosen method changes (debounced): shipping options, tax and the final total.
  const addrKey = `${form.line1}|${form.city}|${form.region}|${form.postalCode}|${form.country}|${method}|${cart.version}|${cart.items.length}`;
  useEffect(() => {
    if (!cart.loaded || cart.items.length === 0 || !addressReady) return;
    const ctrl = new AbortController();
    const t = setTimeout(async () => {
      setQuoting(true);
      try {
        const r = await fetch('/api/checkout/quote', {
          method: 'POST',
          credentials: 'same-origin',
          signal: ctrl.signal,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            shippingAddress: {
              name: form.name || undefined,
              line1: form.line1,
              line2: form.line2 || undefined,
              city: form.city,
              region: form.region,
              postalCode: form.postalCode,
              country: form.country,
            },
            ...(method ? { shippingMethodId: method } : {}),
          }),
        });
        const d = (await r.json()) as QuoteView & ApiError;
        if (!r.ok) {
          setQuote(null);
          setError(d.error?.message ?? 'We could not price this order.');
          return;
        }
        setError(null);
        setQuote(d);
        if (!method && d.shippingOptions[0]) setMethod(d.shippingOptions[0].methodId);
        if (method && !d.shippingOptions.some((o) => o.methodId === method))
          setMethod(d.shippingOptions[0]?.methodId ?? '');
      } catch {
        /* aborted or offline: keep the last quote */
      } finally {
        setQuoting(false);
      }
    }, 350);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [addrKey, cart.loaded, addressReady]);

  const set = (k: keyof Form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));
  const blur = (k: keyof Form) => () => setTouched((t) => ({ ...t, [k]: true }));
  const field = (
    k: keyof Form,
    label: string,
    props: React.InputHTMLAttributes<HTMLInputElement> = {},
    cls = '',
  ) => (
    <div className={`field ${cls}`}>
      <label htmlFor={`f-${k}`}>{label}</label>
      <input
        id={`f-${k}`}
        name={k}
        value={form[k]}
        onChange={set(k)}
        onBlur={blur(k)}
        aria-invalid={touched[k] && errors[k] ? true : undefined}
        aria-describedby={touched[k] && errors[k] ? `e-${k}` : undefined}
        {...props}
      />
      {touched[k] && errors[k] ? (
        <span id={`e-${k}`} className="field__error">
          {errors[k]}
        </span>
      ) : null}
    </div>
  );

  if (cart.loaded && cart.items.length === 0)
    return (
      <div className="empty-state">
        <div className="drawer__empty-art" aria-hidden="true">
          <Bag width={44} height={44} />
        </div>
        <h2 className="h-section" style={{ marginTop: 0 }}>
          Your bag is empty
        </h2>
        <Link href={`${base}/products`} className="btn btn--primary btn--lg">
          Browse the shop <Arrow width={20} height={20} />
        </Link>
      </div>
    );

  const canPlace =
    Object.keys(errors).length === 0 &&
    !!quote?.selectedShipping &&
    !!gateway &&
    !placing &&
    !quoting;

  async function place(e: React.FormEvent) {
    e.preventDefault();
    setTouched(Object.fromEntries(REQUIRED.map((k) => [k, true])));
    if (!canPlace || !quote) return;
    setPlacing(true);
    setError(null);
    // One key per attempt (kept in sessionStorage): a double-click or a retry after a timeout can never place two orders.
    idem.current ||= sessionStorage.getItem('sold_idem') || crypto.randomUUID();
    sessionStorage.setItem('sold_idem', idem.current);
    try {
      const placed = await post<{ orderToken: string; order: { number: string } }>(
        '/api/checkout',
        {
          email: form.email.trim(),
          shippingMethodId: method,
          shippingAddress: {
            name: form.name,
            line1: form.line1,
            line2: form.line2 || undefined,
            city: form.city,
            region: form.region,
            postalCode: form.postalCode,
            country: form.country,
          },
        },
        { 'idempotency-key': idem.current },
      );
      if (!placed.ok) {
        const code = placed.data.error?.code;
        if (code === 'quote_changed')
          setError(
            'The price changed while you were checking out. Please review the new total and try again.',
          );
        else if (code === 'insufficient_stock')
          setError('Sorry, something in your bag just sold out. Please review your bag.');
        else if (code === 'cart_closed' || code === 'not_found')
          setError('Your bag is no longer available. Please start again.');
        else
          setError(
            placed.data.error?.message ?? 'We could not place your order. Please try again.',
          );
        if (code === 'quote_changed' || code === 'insufficient_stock') idem.current = '';
        if (code === 'quote_changed' || code === 'insufficient_stock')
          sessionStorage.removeItem('sold_idem');
        return;
      }
      sessionStorage.removeItem('sold_idem');
      const token = placed.data.orderToken;
      const paid = await post<{ payment: { instructions?: string; redirectUrl?: string } }>(
        '/api/checkout/pay',
        {
          orderToken: token,
          gatewayId: gateway,
          returnUrl: `${location.origin}${base}/order/${token}`,
        },
      );
      if (paid.ok && paid.data.payment.instructions)
        sessionStorage.setItem(`sold_pay_${token.slice(0, 8)}`, paid.data.payment.instructions);
      if (paid.ok && paid.data.payment.redirectUrl) {
        location.href = paid.data.payment.redirectUrl;
        return;
      }
      await cart.refresh();
      router.push(`${base}/order/${token}`);
    } catch {
      setError('Network problem. Nothing was charged. Please try again.');
    } finally {
      setPlacing(false);
    }
  }

  return (
    <form className="two-col" onSubmit={place} noValidate>
      <div>
        <section className="panel" aria-labelledby="s-contact">
          <h2 id="s-contact">
            <span className="step-num" aria-hidden="true">
              1
            </span>
            Contact
          </h2>
          {field('email', 'Email', {
            type: 'email',
            autoComplete: 'email',
            inputMode: 'email',
            required: true,
          })}
          <p className="field__hint" style={{ marginTop: '0.5rem' }}>
            We’ll send your order confirmation here.
          </p>
        </section>

        <section className="panel" aria-labelledby="s-ship">
          <h2 id="s-ship">
            <span className="step-num" aria-hidden="true">
              2
            </span>
            Delivery address
          </h2>
          <div className="form-grid">
            {field('name', 'Full name', { autoComplete: 'name', required: true }, 'full')}
            {field('line1', 'Address', { autoComplete: 'address-line1', required: true }, 'full')}
            {field(
              'line2',
              'Apartment, suite, etc. (optional)',
              { autoComplete: 'address-line2' },
              'full',
            )}
            {field('city', 'City / suburb', { autoComplete: 'address-level2', required: true })}
            {field('region', 'State / region', { autoComplete: 'address-level1' })}
            {field('postalCode', 'Postcode', { autoComplete: 'postal-code', required: true })}
            <div className="field">
              <label htmlFor="f-country">Country</label>
              <select
                id="f-country"
                name="country"
                value={form.country}
                onChange={set('country')}
                autoComplete="country"
              >
                {COUNTRIES.map(([c, n]) => (
                  <option key={c} value={c}>
                    {n}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </section>

        <section className="panel" aria-labelledby="s-delivery">
          <h2 id="s-delivery">
            <span className="step-num" aria-hidden="true">
              3
            </span>
            Delivery method
          </h2>
          {!addressReady ? (
            <p className="muted">Enter your address to see delivery options.</p>
          ) : null}
          {addressReady && quoting && !quote ? (
            <p className="muted" role="status">
              Finding delivery options…
            </p>
          ) : null}
          {addressReady && quote && quote.shippingOptions.length === 0 ? (
            <p className="alert" style={{ margin: 0 }} role="alert">
              Sorry, we don’t deliver to that address yet.
            </p>
          ) : null}
          <div role="radiogroup" aria-label="Delivery method">
            {quote?.shippingOptions.map((o) => (
              <label key={o.methodId} className="choice">
                <span className="choice__main">
                  <input
                    type="radio"
                    name="shipping"
                    value={o.methodId}
                    checked={method === o.methodId}
                    onChange={() => setMethod(o.methodId)}
                  />
                  <span>
                    {o.label}
                    <small>
                      {o.estimatedDaysMin}–{o.estimatedDaysMax} business days
                    </small>
                  </span>
                </span>
                <strong>
                  {BigInt(o.amount.amount) === 0n ? 'Free' : formatMoney(o.amount, tag)}
                </strong>
              </label>
            ))}
          </div>
        </section>

        <section className="panel" aria-labelledby="s-pay">
          <h2 id="s-pay">
            <span className="step-num" aria-hidden="true">
              4
            </span>
            Payment
          </h2>
          <div role="radiogroup" aria-label="Payment method">
            {gateways.map((g) => (
              <label key={g.id} className="choice">
                <span className="choice__main">
                  <input
                    type="radio"
                    name="gateway"
                    value={g.id}
                    checked={gateway === g.id}
                    onChange={() => setGateway(g.id)}
                  />
                  <span>
                    {g.displayName}
                    {g.id === 'manual' ? (
                      <small>You’ll get payment instructions after placing the order</small>
                    ) : null}
                  </span>
                </span>
              </label>
            ))}
          </div>
          {gateways.length === 0 ? (
            <p className="muted">No payment methods are available for {currency}.</p>
          ) : null}
        </section>
      </div>

      <aside className="summary panel" aria-label="Order summary">
        <h2 style={{ marginBottom: 0 }}>Order summary</h2>
        <ul>
          {cart.items.map((i) => (
            <li
              key={i.variantId}
              className="line"
              style={{ gridTemplateColumns: '4rem 1fr auto', paddingBlock: '0.7rem' }}
            >
              <span className="line__media" style={{ position: 'relative' }}>
                {i.image ? <img src={i.image} alt="" width={64} height={80} /> : null}
              </span>
              <span className="line__body">
                <span className="line__title">{i.title}</span>
                <span className="line__price">Qty {i.quantity}</span>
              </span>
              <span className="line__total">
                <strong>{formatMoney(i.lineTotal, tag)}</strong>
              </span>
            </li>
          ))}
        </ul>
        <div className="sum">
          <span>Items</span>
          <span>{cart.estimate ? formatMoney(cart.estimate.subtotal, tag) : '—'}</span>
        </div>
        {cart.estimate?.discounts.map((d) => (
          <div key={d.name} className="sum sum--discount">
            <span>{d.name}</span>
            <span>−{formatMoney(d.amount, tag)}</span>
          </div>
        ))}
        <div className="sum">
          <span>Delivery</span>
          <span>
            {quote?.selectedShipping
              ? BigInt(quote.shippingTotal.amount) === 0n
                ? 'Free'
                : formatMoney(quote.shippingTotal, tag)
              : 'Calculated next'}
          </span>
        </div>
        {quote ? (
          <div className="sum muted small">
            <span>{quote.pricesIncludeTax ? 'Includes tax of' : 'Tax'}</span>
            <span>{formatMoney(quote.taxTotal, tag)}</span>
          </div>
        ) : null}
        <div className="sum sum--total" aria-live="polite">
          <span>Total</span>
          <strong>
            {quote?.selectedShipping
              ? formatMoney(quote.total, tag)
              : cart.estimate
                ? formatMoney(cart.estimate.net, tag)
                : '—'}
          </strong>
        </div>
        {error ? (
          <p className="alert" role="alert" style={{ margin: 0 }}>
            {error}
          </p>
        ) : null}
        <button
          type="submit"
          className="btn btn--primary btn--lg btn--block"
          disabled={!canPlace && Object.keys(errors).length === 0}
        >
          {placing ? 'Placing order…' : 'Place order'}{' '}
          {!placing ? <Arrow width={20} height={20} /> : null}
        </button>
        <p className="muted small center">
          By placing your order you agree to our terms. You won’t be charged twice if you click
          again.
        </p>
      </aside>
    </form>
  );
}
