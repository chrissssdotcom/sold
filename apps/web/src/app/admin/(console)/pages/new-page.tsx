'use client';
import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '../../_components/api';

const LOCALES = ['en-au', 'en-us', 'en-nz', 'en-gb'];

export function NewPage() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    try {
      const p = await api<{ id: string }>('POST', '/api/admin/pages', {
        title: String(f.get('title')),
        path: String(f.get('path')),
        locale: String(f.get('locale')),
      });
      router.push(`/admin/pages/${p.id}`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }
  return (
    <form className="card" onSubmit={submit}>
      <div className="card-h">
        <h2>New page</h2>
      </div>
      <div className="card-b">
        {error ? (
          <div className="alert" role="alert">
            {error}
          </div>
        ) : null}
        <div className="field">
          <label htmlFor="np-title">Title</label>
          <input id="np-title" name="title" className="input" required maxLength={200} />
        </div>
        <div className="two">
          <div className="field">
            <label htmlFor="np-path">Path</label>
            <input
              id="np-path"
              name="path"
              className="input mono"
              required
              placeholder="/about"
              defaultValue="/"
            />
          </div>
          <div className="field">
            <label htmlFor="np-locale">Market</label>
            <select id="np-locale" name="locale" className="select">
              {LOCALES.map((l) => (
                <option key={l}>{l}</option>
              ))}
            </select>
          </div>
        </div>
        <button className="btn primary" disabled={busy}>
          Create and edit
        </button>
      </div>
    </form>
  );
}
