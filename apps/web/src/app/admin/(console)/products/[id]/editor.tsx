'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '../../../_components/api';
import { useToast } from '../../../_components/toast';
import { formatMinor } from '../../../_components/ui';
import { toMinor } from '../new/form';

interface V {
  id: string;
  sku: string;
  title: string;
  options: Record<string, string>;
  onHand: number;
  reserved: number;
  allowBackorder: boolean;
  prices: { currency: string; amount: string }[];
}

export function ProductEditor(p: {
  id: string;
  status: 'draft' | 'active' | 'archived';
  handle: string;
  variants: V[];
  canWrite: boolean;
  canPublish: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  async function run(fn: () => Promise<unknown>, ok: string) {
    setBusy(true);
    try {
      await fn();
      toast(ok);
      router.refresh();
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  }
  const setStatus = (status: string) =>
    run(() => api('PATCH', `/api/admin/products/${p.id}`, { status }), `Product is now ${status}`);

  return (
    <div className="grid" style={{ gap: 20 }}>
      <div className="card">
        <div className="card-h">
          <h2>Visibility</h2>
          <div className="row">
            {p.status !== 'active' ? (
              <button
                className="btn primary"
                disabled={busy || !p.canPublish}
                title={p.canPublish ? '' : 'Needs catalog:publish'}
                onClick={() => setStatus('active')}
              >
                Publish
              </button>
            ) : (
              <button
                className="btn"
                disabled={busy || !p.canWrite}
                onClick={() => setStatus('draft')}
              >
                Unpublish
              </button>
            )}
            {p.status !== 'archived' ? (
              <button
                className="btn danger"
                disabled={busy || !p.canWrite}
                onClick={() => setStatus('archived')}
              >
                Archive
              </button>
            ) : null}
          </div>
        </div>
        <div className="card-b muted">
          Live at <span className="mono">/products/{p.handle}</span> when active. Drafts and
          archived products are never shown in the storefront.
        </div>
      </div>
      {p.variants.map((v) => (
        <VariantCard key={v.id} v={v} canWrite={p.canWrite} run={run} />
      ))}
    </div>
  );
}

function VariantCard({
  v,
  canWrite,
  run,
}: {
  v: V;
  canWrite: boolean;
  run: (fn: () => Promise<unknown>, ok: string) => Promise<void>;
}) {
  const [stock, setStock] = useState(String(v.onHand));
  const [backorder, setBackorder] = useState(v.allowBackorder);
  const [prices, setPrices] = useState(() =>
    Object.fromEntries(
      v.prices.map((x) => [
        x.currency,
        (Number(x.amount) / (x.currency === 'JPY' ? 1 : 100)).toFixed(x.currency === 'JPY' ? 0 : 2),
      ]),
    ),
  );
  return (
    <div className="card">
      <div className="card-h">
        <div>
          <h2>{v.title || v.sku}</h2>
          <span className="muted mono">{v.sku}</span>
        </div>
        <span className="muted">
          {v.reserved} reserved · {Math.max(0, v.onHand - v.reserved)} available
        </span>
      </div>
      <div className="card-b two">
        <div>
          <div className="field">
            <label htmlFor={`stock-${v.id}`}>Stock on hand</label>
            <input
              id={`stock-${v.id}`}
              className="input"
              type="number"
              min={v.reserved}
              step="1"
              value={stock}
              disabled={!canWrite}
              onChange={(e) => setStock(e.target.value)}
            />
            <span className="hint">
              Cannot go below what is already reserved by open orders ({v.reserved}).
            </span>
          </div>
          <label className="row" style={{ marginBottom: 12 }}>
            <input
              type="checkbox"
              checked={backorder}
              disabled={!canWrite}
              onChange={(e) => setBackorder(e.target.checked)}
            />{' '}
            Allow backorders
          </label>
          <button
            className="btn"
            disabled={!canWrite}
            onClick={() =>
              run(
                () =>
                  api('PUT', `/api/admin/variants/${v.id}/stock`, {
                    onHand: Number(stock),
                    allowBackorder: backorder,
                  }),
                'Stock saved',
              )
            }
          >
            Save stock
          </button>
        </div>
        <div>
          {v.prices.map((x) => (
            <div className="field" key={x.currency}>
              <label htmlFor={`price-${v.id}-${x.currency}`}>
                Price ({x.currency}){' '}
                <span className="muted">now {formatMinor(x.amount, x.currency)}</span>
              </label>
              <div className="row">
                <input
                  id={`price-${v.id}-${x.currency}`}
                  className="input"
                  style={{ maxWidth: 160 }}
                  inputMode="decimal"
                  value={prices[x.currency] ?? ''}
                  disabled={!canWrite}
                  onChange={(e) => setPrices({ ...prices, [x.currency]: e.target.value })}
                />
                <button
                  className="btn"
                  disabled={!canWrite}
                  onClick={() => {
                    const minor = toMinor(prices[x.currency] ?? '', x.currency === 'JPY' ? 0 : 2);
                    if (!minor)
                      return run(() => Promise.reject(new Error('Enter a valid price')), '');
                    return run(
                      () =>
                        api('PUT', `/api/admin/variants/${v.id}/price`, {
                          currency: x.currency,
                          amount: minor,
                        }),
                      'Price saved',
                    );
                  }}
                >
                  Save
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
