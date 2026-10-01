'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '../../../_components/api';
import { useToast } from '../../../_components/toast';
import { formatMinor } from '../../../_components/ui';
import { toMinor } from '../../products/new/form';

const NEXT: Record<string, { to: string; label: string; kind: 'fulfil' | 'cancel' }[]> = {
  pending_payment: [{ to: 'cancelled', label: 'Cancel order', kind: 'cancel' }],
  paid: [
    { to: 'processing', label: 'Start processing', kind: 'fulfil' },
    { to: 'cancelled', label: 'Cancel order', kind: 'cancel' },
  ],
  processing: [
    { to: 'shipped', label: 'Mark shipped', kind: 'fulfil' },
    { to: 'cancelled', label: 'Cancel order', kind: 'cancel' },
  ],
  shipped: [{ to: 'delivered', label: 'Mark delivered', kind: 'fulfil' }],
};

interface Pay {
  id: string;
  gateway: string;
  status: string;
  refundable: string;
}

export function OrderActions(p: {
  orderId: string;
  status: string;
  currency: string;
  payments: Pay[];
  can: { fulfil: boolean; cancel: boolean; refund: boolean; confirm: boolean };
}) {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  // One key per form instance: a double-click or a retry after a timeout cannot refund twice.
  const [key, setKey] = useState(() => crypto.randomUUID());

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

  const steps = (NEXT[p.status] ?? []).filter((s) => p.can[s.kind]);
  const refundable = p.payments.find((x) => BigInt(x.refundable) > 0n);
  const manualPending = p.payments.find(
    (x) => x.gateway === 'manual' && x.status !== 'captured' && x.status !== 'refunded',
  );
  return (
    <section className="card" aria-labelledby="act">
      <div className="card-h">
        <h2 id="act">Actions</h2>
      </div>
      <div className="card-b">
        {steps.length === 0 && !refundable && !manualPending ? (
          <p className="muted">Nothing to do for this order.</p>
        ) : null}
        {manualPending && p.can.confirm ? (
          <div className="field">
            <span className="lbl">Manual payment</span>
            <button
              className="btn primary"
              disabled={busy}
              onClick={() =>
                run(
                  () => api('POST', `/api/admin/payments/${manualPending.id}/confirm`),
                  'Payment confirmed',
                )
              }
            >
              Confirm payment received
            </button>
          </div>
        ) : null}
        {steps.length > 0 ? (
          <div className="row" style={{ marginBottom: 16 }}>
            {steps.map((s) => (
              <button
                key={s.to}
                className={`btn ${s.kind === 'cancel' ? 'danger' : 'primary'}`}
                disabled={busy}
                onClick={() => {
                  if (s.kind === 'cancel' && !confirm('Cancel this order? Held stock is released.'))
                    return;
                  return run(
                    () => api('POST', `/api/admin/orders/${p.orderId}/transition`, { to: s.to }),
                    `Order ${s.to}`,
                  );
                }}
              >
                {s.label}
              </button>
            ))}
          </div>
        ) : null}
        {refundable && p.can.refund ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const minor = toMinor(amount, p.currency === 'JPY' ? 0 : 2);
              if (!minor) return toast('Enter a valid amount', true);
              if (BigInt(minor) > BigInt(refundable.refundable))
                return toast('That is more than was captured', true);
              if (!confirm(`Refund ${formatMinor(minor, p.currency)}? This cannot be undone.`))
                return;
              return run(
                () =>
                  api('POST', `/api/admin/payments/${refundable.id}/refund`, {
                    amount: minor,
                    currency: p.currency,
                    reason,
                    idempotencyKey: key,
                  }),
                'Refund requested',
              ).then((done) => {
                if (!done) return; // keep the key: a retry after a failure must replay, never double-refund
                setKey(crypto.randomUUID()); // the next refund is a new intent, not a replay of this one
                setAmount('');
                setReason('');
              });
            }}
          >
            <h3 style={{ fontSize: 14, margin: '8px 0' }}>Refund</h3>
            <div className="two">
              <div className="field">
                <label htmlFor="ramt">
                  Amount (max {formatMinor(refundable.refundable, p.currency)})
                </label>
                <input
                  id="ramt"
                  className="input"
                  inputMode="decimal"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  required
                />
              </div>
              <div className="field">
                <label htmlFor="rwhy">Reason</label>
                <input
                  id="rwhy"
                  className="input"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  required
                  maxLength={500}
                />
              </div>
            </div>
            <button className="btn danger" disabled={busy}>
              Refund
            </button>
          </form>
        ) : null}
      </div>
    </section>
  );
}
