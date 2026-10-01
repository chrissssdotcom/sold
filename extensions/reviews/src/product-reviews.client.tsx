'use client';
import { useCallback, useEffect, useState, type FormEvent } from 'react';

interface Review {
  id: string;
  rating: number;
  title: string;
  body: string;
  authorName: string;
  createdAt: string;
}
interface Listing {
  summary: { count: number; average: number; distribution: Record<string, number> };
  reviews: Review[];
  nextCursor: string | null;
}

const base = '/x/reviews/products';

function Stars({ value, label }: { value: number; label: string }) {
  const full = Math.round(value);
  return (
    <span
      role="img"
      aria-label={label}
      style={{ color: 'var(--accent, #a94a22)', letterSpacing: 2 }}
    >
      {'★★★★★'.slice(0, full)}
      <span style={{ opacity: 0.25 }}>{'★★★★★'.slice(full)}</span>
    </span>
  );
}

/** Reviews for one product: summary, list, and (for a signed-in buyer) a form. Server rules decide who may post. */
export default function ProductReviews({ productId }: { productId: string }) {
  const [data, setData] = useState<Listing | null>(null);
  const [error, setError] = useState(false);
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`${base}/${productId}/reviews?limit=5`);
      if (!res.ok) throw new Error(String(res.status));
      setData((await res.json()) as Listing);
    } catch {
      setError(true);
    }
  }, [productId]);

  useEffect(() => {
    void load();
    fetch('/api/auth/me')
      .then((r) => r.json())
      .then((d: { user: unknown }) => setSignedIn(Boolean(d.user)))
      .catch(() => setSignedIn(false));
  }, [load]);

  async function more() {
    if (!data?.nextCursor) return;
    setLoadingMore(true);
    try {
      const res = await fetch(`${base}/${productId}/reviews?limit=5&before=${data.nextCursor}`);
      const next = (await res.json()) as Listing;
      setData({
        ...data,
        reviews: [...data.reviews, ...next.reviews],
        nextCursor: next.nextCursor,
      });
    } finally {
      setLoadingMore(false);
    }
  }

  if (error) return null; // reviews are an enhancement: never show a broken box on a product page
  if (!data)
    return <section aria-busy="true" aria-label="Customer reviews" style={{ minHeight: 80 }} />;

  return (
    <section aria-labelledby="reviews-h" style={{ paddingBlock: '2rem' }}>
      <h2 id="reviews-h" className="h-section" style={{ marginTop: 0 }}>
        Customer reviews
      </h2>
      {data.summary.count > 0 ? (
        <p>
          <Stars value={data.summary.average} label={`${data.summary.average} out of 5 stars`} />{' '}
          <strong>{data.summary.average.toFixed(1)}</strong> from {data.summary.count} review
          {data.summary.count === 1 ? '' : 's'}
        </p>
      ) : (
        <p className="muted">No reviews yet.</p>
      )}
      <ul style={{ listStyle: 'none', padding: 0, display: 'grid', gap: '1rem' }}>
        {data.reviews.map((r) => (
          <li key={r.id}>
            <Stars value={r.rating} label={`${r.rating} out of 5 stars`} />{' '}
            {r.title ? <strong>{r.title}</strong> : null}
            <p style={{ margin: '0.25rem 0', whiteSpace: 'pre-line' }}>{r.body}</p>
            <small className="muted">
              {r.authorName} · verified buyer · {new Date(r.createdAt).toLocaleDateString()}
            </small>
          </li>
        ))}
      </ul>
      {data.nextCursor ? (
        <button className="btn btn--ghost" onClick={more} disabled={loadingMore}>
          {loadingMore ? 'Loading…' : 'More reviews'}
        </button>
      ) : null}
      <WriteReview productId={productId} signedIn={signedIn} />
    </section>
  );
}

function WriteReview({ productId, signedIn }: { productId: string; signedIn: boolean | null }) {
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  if (signedIn === null) return null;
  if (!signedIn) return <p className="muted">Bought this? Sign in to leave a review.</p>;
  if (!open)
    return (
      <div>
        {message ? (
          <p role="status" className={message.ok ? '' : 'alert'}>
            {message.text}
          </p>
        ) : null}
        <button className="btn" onClick={() => setOpen(true)}>
          Write a review
        </button>
      </div>
    );

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch(`${base}/${productId}/reviews`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          rating: Number(f.get('rating')),
          title: String(f.get('title') ?? ''),
          body: String(f.get('body') ?? ''),
          authorName: String(f.get('authorName') ?? ''),
        }),
      });
      const out = (await res.json().catch(() => ({}))) as {
        status?: string;
        error?: { message?: string; details?: { issues?: { message: string }[] } };
      };
      if (res.ok) {
        setOpen(false);
        setMessage({
          ok: true,
          text:
            out.status === 'approved'
              ? 'Thank you, your review is live.'
              : 'Thank you! Your review will appear once it has been checked.',
        });
      } else {
        setMessage({
          ok: false,
          text:
            out.error?.details?.issues?.[0]?.message ??
            out.error?.message ??
            'Could not save your review.',
        });
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      style={{ display: 'grid', gap: '0.75rem', maxWidth: '34rem', marginTop: '1rem' }}
    >
      {message ? (
        <p role="alert" className="alert">
          {message.text}
        </p>
      ) : null}
      <div className="field">
        <label htmlFor="rv-rating">Rating</label>
        <select id="rv-rating" name="rating" defaultValue="5" required>
          {[5, 4, 3, 2, 1].map((n) => (
            <option key={n} value={n}>
              {n} star{n === 1 ? '' : 's'}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor="rv-title">Headline (optional)</label>
        <input id="rv-title" name="title" maxLength={120} />
      </div>
      <div className="field">
        <label htmlFor="rv-body">Your review</label>
        <textarea id="rv-body" name="body" rows={5} maxLength={4000} required />
      </div>
      <div className="field">
        <label htmlFor="rv-name">Display name (optional)</label>
        <input id="rv-name" name="authorName" maxLength={60} autoComplete="given-name" />
      </div>
      <div>
        <button className="btn btn--primary" disabled={busy}>
          {busy ? 'Sending…' : 'Submit review'}
        </button>{' '}
        <button type="button" className="btn btn--ghost" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </form>
  );
}
