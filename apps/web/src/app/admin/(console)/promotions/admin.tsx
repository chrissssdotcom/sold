'use client';
import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '../../_components/api';
import { useToast } from '../../_components/toast';

interface Row {
  id: string;
  code: string | null;
  name: string;
  active: boolean;
  usage: string;
  ends: string;
  kind: string;
}

export function PromotionsAdmin({ rows, canWrite }: { rows: Row[]; canWrite: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [kind, setKind] = useState<'percent_off' | 'free_shipping'>('percent_off');

  async function run(fn: () => Promise<unknown>, ok: string): Promise<boolean> {
    setBusy(true);
    try {
      await fn();
      toast(ok);
      router.refresh();
      return true;
    } catch (e) {
      toast((e as Error).message, true);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const limit = Number(f.get('limit') || 0);
    const body: Record<string, unknown> = {
      name: String(f.get('name')),
      code: String(f.get('code') || '').trim() || null,
      kind,
      ...(limit > 0 ? { usageLimit: limit } : {}),
    };
    if (kind === 'percent_off') {
      const pct = Number(f.get('percent'));
      if (!(pct > 0 && pct <= 100)) return toast('Percent must be between 0 and 100', true);
      body['basisPoints'] = Math.round(pct * 100);
      body['scope'] = { type: 'order' };
    }
    if (await run(() => api('POST', '/api/admin/promotions', body), 'Promotion created'))
      form.reset();
  }

  return (
    <div className="grid cols-2" style={{ alignItems: 'start' }}>
      <div className="card">
        <div className="table-wrap">
          <table className="t">
            <thead>
              <tr>
                <th>Promotion</th>
                <th>Type</th>
                <th>Used</th>
                <th>Ends</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>
                    <strong>{r.name}</strong>
                    <div className="muted mono">{r.code ?? 'automatic'}</div>
                  </td>
                  <td>{r.kind.replace(/_/g, ' ')}</td>
                  <td className="num">{r.usage}</td>
                  <td className="muted">{r.ends}</td>
                  <td className="num">
                    <button
                      className="btn sm"
                      disabled={!canWrite || busy}
                      onClick={() =>
                        run(
                          () =>
                            api('PATCH', `/api/admin/promotions/${r.id}`, { active: !r.active }),
                          r.active ? 'Deactivated' : 'Activated',
                        )
                      }
                    >
                      {r.active ? 'Deactivate' : 'Activate'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      {canWrite ? (
        <form className="card" onSubmit={create}>
          <div className="card-h">
            <h2>New promotion</h2>
          </div>
          <div className="card-b">
            <div className="field">
              <label htmlFor="p-name">Name</label>
              <input id="p-name" name="name" className="input" required />
            </div>
            <div className="two">
              <div className="field">
                <label htmlFor="p-code">Coupon code</label>
                <input id="p-code" name="code" className="input mono" placeholder="optional" />
                <span className="hint">Blank applies automatically.</span>
              </div>
              <div className="field">
                <label htmlFor="p-kind">Type</label>
                <select
                  id="p-kind"
                  className="select"
                  value={kind}
                  onChange={(e) => setKind(e.target.value as typeof kind)}
                >
                  <option value="percent_off">Percent off</option>
                  <option value="free_shipping">Free shipping</option>
                </select>
              </div>
            </div>
            {kind === 'percent_off' ? (
              <div className="field">
                <label htmlFor="p-pct">Percent off the order</label>
                <input id="p-pct" name="percent" className="input" inputMode="decimal" required />
              </div>
            ) : null}
            <div className="field">
              <label htmlFor="p-limit">Total redemptions</label>
              <input
                id="p-limit"
                name="limit"
                type="number"
                min="1"
                className="input"
                placeholder="unlimited"
              />
            </div>
            <button className="btn primary" disabled={busy}>
              Create promotion
            </button>
          </div>
        </form>
      ) : null}
    </div>
  );
}
