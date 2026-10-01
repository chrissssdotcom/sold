'use client';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api } from '../../_components/api';
import { useToast } from '../../_components/toast';
import { Status, when } from '../../_components/ui';

interface Key {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  expiresAt: string | null;
}
interface Endpoint {
  id: string;
  url: string;
  events: string[];
  active: boolean;
  description: string;
}
interface Delivery {
  id: string;
  endpoint_id: string;
  event_type: string;
  status: string;
  attempts: number;
  last_status: number | null;
  last_error: string | null;
  created_at: string;
}

const SCOPES = ['catalog:read', 'catalog:write', 'orders:read'];

export function Developers({ canWrite }: { canWrite: boolean }) {
  const toast = useToast();
  const [keys, setKeys] = useState<Key[]>([]);
  const [hooks, setHooks] = useState<{
    endpoints: Endpoint[];
    deliveries: Delivery[];
    events: string[];
  }>({ endpoints: [], deliveries: [], events: [] });
  const [secret, setSecret] = useState<{ label: string; value: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [k, h] = await Promise.all([
      api<{ keys: Key[] }>('GET', '/api/admin/api-keys'),
      api<{ endpoints: Endpoint[]; deliveries: Delivery[]; events: string[] }>(
        'GET',
        '/api/admin/webhooks',
      ),
    ]);
    setKeys(k.keys);
    setHooks(h);
  }, []);
  useEffect(() => {
    load().catch((e: Error) => toast(e.message, true));
  }, [load, toast]);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    try {
      await fn();
      await load();
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  }

  const newKey = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const scopes = SCOPES.filter((s) => f.get(`scope-${s}`) === 'on');
    return run(async () => {
      const days = Number(f.get('days') || 0);
      const r = await api<{ token: string }>('POST', '/api/admin/api-keys', {
        name: String(f.get('name')),
        scopes,
        ...(days > 0 ? { expiresInDays: days } : {}),
      });
      setSecret({ label: 'API key', value: r.token });
      form.reset();
    });
  };
  const newHook = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    return run(async () => {
      const r = await api<{ secret: string }>('POST', '/api/admin/webhooks', {
        url: String(f.get('url')),
        description: String(f.get('description') ?? ''),
        events: hooks.events.filter((ev) => f.get(`ev-${ev}`) === 'on'),
      });
      setSecret({ label: 'Signing secret', value: r.secret });
      form.reset();
    });
  };

  return (
    <div className="grid" style={{ gap: 20 }}>
      {secret ? (
        <div className="alert ok" role="status">
          <strong>{secret.label} (shown once, copy it now):</strong>
          <div className="mono" style={{ wordBreak: 'break-all', margin: '6px 0' }}>
            {secret.value}
          </div>
          <button className="btn sm" onClick={() => setSecret(null)}>
            I have saved it
          </button>
        </div>
      ) : null}

      <section className="card" aria-labelledby="keys-h">
        <div className="card-h">
          <h2 id="keys-h">API keys</h2>
        </div>
        <div className="table-wrap" tabIndex={0} role="region" aria-label="API keys">
          <table className="t">
            <thead>
              <tr>
                <th>Name</th>
                <th>Scopes</th>
                <th>Last used</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {keys.map((k) => (
                <tr key={k.id}>
                  <td>
                    <strong>{k.name}</strong>
                    <div className="muted mono">sk_{k.prefix}_…</div>
                  </td>
                  <td className="mono">{k.scopes.join(' ')}</td>
                  <td className="muted">{when(k.lastUsedAt)}</td>
                  <td>
                    <Status value={k.revokedAt ? 'disabled' : 'active'} />
                  </td>
                  <td className="num">
                    {canWrite && !k.revokedAt ? (
                      <button
                        className="btn sm danger"
                        disabled={busy}
                        onClick={() =>
                          confirm(
                            `Revoke "${k.name}"? Anything using it stops working immediately.`,
                          ) &&
                          run(async () => void (await api('DELETE', `/api/admin/api-keys/${k.id}`)))
                        }
                      >
                        Revoke
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {canWrite ? (
          <form className="card-b" onSubmit={newKey}>
            <div className="two">
              <div className="field">
                <label htmlFor="k-name">New key name</label>
                <input
                  id="k-name"
                  name="name"
                  className="input"
                  required
                  maxLength={80}
                  placeholder="Warehouse sync"
                />
              </div>
              <div className="field">
                <label htmlFor="k-days">Expires after (days, optional)</label>
                <input id="k-days" name="days" type="number" min="1" max="730" className="input" />
              </div>
            </div>
            <fieldset style={{ border: 0, padding: 0, margin: '0 0 12px' }}>
              <legend style={{ fontWeight: 600 }}>Scopes</legend>
              <div className="row">
                {SCOPES.map((s) => (
                  <label key={s} className="row" style={{ gap: 6 }}>
                    <input
                      type="checkbox"
                      name={`scope-${s}`}
                      defaultChecked={s.endsWith(':read')}
                    />{' '}
                    <span className="mono">{s}</span>
                  </label>
                ))}
              </div>
            </fieldset>
            <button className="btn primary" disabled={busy}>
              Create key
            </button>
          </form>
        ) : null}
      </section>

      <section className="card" aria-labelledby="hooks-h">
        <div className="card-h">
          <h2 id="hooks-h">Webhooks</h2>
        </div>
        <div className="table-wrap" tabIndex={0} role="region" aria-label="Webhook endpoints">
          <table className="t">
            <thead>
              <tr>
                <th>Endpoint</th>
                <th>Events</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {hooks.endpoints.map((h) => (
                <tr key={h.id}>
                  <td>
                    <span className="mono">{h.url}</span>
                    <div className="muted">{h.description}</div>
                  </td>
                  <td className="mono">{h.events.join(' ')}</td>
                  <td>
                    <Status value={h.active ? 'active' : 'disabled'} />
                  </td>
                  <td className="num">
                    {canWrite ? (
                      <div className="row" style={{ justifyContent: 'flex-end' }}>
                        <button
                          className="btn sm"
                          disabled={busy}
                          onClick={() =>
                            run(
                              async () =>
                                void (await api('PATCH', `/api/admin/webhooks/${h.id}`, {
                                  active: !h.active,
                                })),
                            )
                          }
                        >
                          {h.active ? 'Pause' : 'Resume'}
                        </button>
                        <button
                          className="btn sm danger"
                          disabled={busy}
                          onClick={() =>
                            confirm('Delete this endpoint and its delivery log?') &&
                            run(
                              async () => void (await api('DELETE', `/api/admin/webhooks/${h.id}`)),
                            )
                          }
                        >
                          Delete
                        </button>
                      </div>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {canWrite ? (
          <form className="card-b" onSubmit={newHook}>
            <div className="two">
              <div className="field">
                <label htmlFor="w-url">Endpoint URL (https)</label>
                <input
                  id="w-url"
                  name="url"
                  type="url"
                  className="input"
                  required
                  placeholder="https://example.com/sold-webhook"
                />
              </div>
              <div className="field">
                <label htmlFor="w-desc">Description</label>
                <input id="w-desc" name="description" className="input" maxLength={200} />
              </div>
            </div>
            <fieldset style={{ border: 0, padding: 0, margin: '0 0 12px' }}>
              <legend style={{ fontWeight: 600 }}>Events</legend>
              <div className="row">
                {hooks.events.map((ev) => (
                  <label key={ev} className="row" style={{ gap: 6 }}>
                    <input
                      type="checkbox"
                      name={`ev-${ev}`}
                      defaultChecked={ev === 'order.placed'}
                    />{' '}
                    <span className="mono">{ev}</span>
                  </label>
                ))}
              </div>
            </fieldset>
            <button className="btn primary" disabled={busy}>
              Add endpoint
            </button>
          </form>
        ) : null}
        <div className="card-h" style={{ borderTop: '1px solid var(--a-line)' }}>
          <h2>Recent deliveries</h2>
        </div>
        <div className="table-wrap" tabIndex={0} role="region" aria-label="Recent deliveries">
          <table className="t">
            <thead>
              <tr>
                <th>When</th>
                <th>Event</th>
                <th>Status</th>
                <th className="num">Attempts</th>
                <th>Last response</th>
              </tr>
            </thead>
            <tbody>
              {hooks.deliveries.map((d) => (
                <tr key={d.id}>
                  <td className="muted">{when(d.created_at)}</td>
                  <td className="mono">{d.event_type}</td>
                  <td>
                    <Status
                      value={
                        d.status === 'delivered'
                          ? 'paid'
                          : d.status === 'failed'
                            ? 'failed'
                            : 'pending_payment'
                      }
                    />
                  </td>
                  <td className="num">{d.attempts}</td>
                  <td className="muted">{d.last_status ?? d.last_error ?? '—'}</td>
                </tr>
              ))}
              {hooks.deliveries.length === 0 ? (
                <tr>
                  <td colSpan={5} className="muted">
                    No deliveries yet.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
