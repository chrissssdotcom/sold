'use client';
import { useCallback, useEffect, useState } from 'react';

interface Item {
  id: string;
  productTitle: string | null;
  rating: number;
  title: string;
  body: string;
  authorName: string;
  createdAt: string;
}

/** The admin moderation queue. Talks to this extension's own admin routes, which check `reviews.moderate` themselves. */
export default function ModerationQueue() {
  const [items, setItems] = useState<Item[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch('/admin/x/reviews/queue');
    if (!res.ok) return setError('Could not load the queue');
    setItems(((await res.json()) as { items: Item[] }).items);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  async function decide(id: string, status: 'approved' | 'rejected') {
    setBusyId(id);
    setError(null);
    const res = await fetch(`/admin/x/reviews/reviews/${id}/moderate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status }),
    });
    setBusyId(null);
    if (!res.ok) return setError('Could not save that decision');
    setItems((cur) => (cur ?? []).filter((i) => i.id !== id));
  }

  if (items === null && !error) return <p className="muted">Loading…</p>;
  return (
    <div className="card">
      {error ? (
        <div className="alert" role="alert">
          {error}
        </div>
      ) : null}
      {items?.length === 0 ? <div className="empty">Nothing waiting. 🎉</div> : null}
      {items?.map((i) => (
        <div key={i.id} className="card-b" style={{ borderBottom: '1px solid var(--a-line)' }}>
          <div className="row between">
            <strong>{i.productTitle ?? 'Unknown product'}</strong>
            <span aria-label={`${i.rating} out of 5`}>
              {'★'.repeat(i.rating)}
              {'☆'.repeat(5 - i.rating)}
            </span>
          </div>
          {i.title ? <div style={{ fontWeight: 600 }}>{i.title}</div> : null}
          <p style={{ whiteSpace: 'pre-line' }}>{i.body}</p>
          <div className="muted" style={{ marginBottom: 10 }}>
            {i.authorName} · {new Date(i.createdAt).toLocaleString()}
          </div>
          <div className="row">
            <button
              className="btn primary sm"
              disabled={busyId === i.id}
              onClick={() => decide(i.id, 'approved')}
            >
              Approve
            </button>
            <button
              className="btn danger sm"
              disabled={busyId === i.id}
              onClick={() => decide(i.id, 'rejected')}
            >
              Reject
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
