'use client';
import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '../../../_components/api';

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 120);

/** "19.99" -> "1999". Strings only: money never passes through a float. */
export function toMinor(input: string, digits = 2): string | null {
  const m = /^(\d{1,12})(?:\.(\d{1,}))?$/.exec(input.trim());
  if (!m) return null;
  const frac = m[2] ?? '';
  if (frac.length > digits) return null;
  return (m[1]! + frac.padEnd(digits, '0')).replace(/^0+(?=\d)/, '');
}

export function NewProductForm() {
  const router = useRouter();
  const [title, setTitle] = useState('');
  const [handle, setHandle] = useState('');
  const [touched, setTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const currency = String(f.get('currency'));
    const digits = currency === 'JPY' ? 0 : 2;
    const amount = toMinor(String(f.get('price')), digits);
    if (!amount) return setError(`Enter the price as a number with up to ${digits} decimals.`);
    setBusy(true);
    setError(null);
    try {
      const p = await api<{ id: string }>('POST', '/api/admin/products', {
        handle,
        title,
        description: String(f.get('description') ?? ''),
        status: 'draft',
        variants: [
          {
            sku: String(f.get('sku')),
            prices: [{ currency, amount }],
            onHand: Number(f.get('stock') || 0),
          },
        ],
      });
      router.push(`/admin/products/${p.id}`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <form className="card" onSubmit={submit} style={{ maxWidth: 720 }}>
      <div className="card-b">
        {error ? (
          <div className="alert" role="alert">
            {error}
          </div>
        ) : null}
        <div className="field">
          <label htmlFor="title">Title</label>
          <input
            id="title"
            className="input"
            required
            value={title}
            onChange={(e) => {
              setTitle(e.target.value);
              if (!touched) setHandle(slug(e.target.value));
            }}
          />
        </div>
        <div className="field">
          <label htmlFor="handle">URL handle</label>
          <input
            id="handle"
            className="input mono"
            required
            value={handle}
            onChange={(e) => {
              setTouched(true);
              setHandle(e.target.value);
            }}
          />
          <span className="hint">
            Lowercase letters, digits and dashes. It becomes /products/{handle || '…'}.
          </span>
        </div>
        <div className="field">
          <label htmlFor="description">Description</label>
          <textarea id="description" name="description" className="textarea" />
        </div>
        <div className="two">
          <div className="field">
            <label htmlFor="sku">SKU</label>
            <input id="sku" name="sku" className="input mono" required />
          </div>
          <div className="field">
            <label htmlFor="stock">Stock on hand</label>
            <input
              id="stock"
              name="stock"
              type="number"
              min="0"
              step="1"
              defaultValue="0"
              className="input"
            />
          </div>
        </div>
        <div className="two">
          <div className="field">
            <label htmlFor="price">Price</label>
            <input
              id="price"
              name="price"
              inputMode="decimal"
              className="input"
              required
              placeholder="19.99"
            />
          </div>
          <div className="field">
            <label htmlFor="currency">Currency</label>
            <select id="currency" name="currency" className="select" defaultValue="AUD">
              {['AUD', 'USD', 'NZD', 'EUR', 'GBP', 'JPY'].map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </div>
        </div>
        <p className="muted">
          Saved as a draft. Publish it from the product page when it is ready.
        </p>
        <button className="btn primary" disabled={busy}>
          {busy ? 'Saving…' : 'Create draft'}
        </button>
      </div>
    </form>
  );
}
