'use client';
import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../../../_components/api';
import { useToast } from '../../../_components/toast';

interface Field {
  key: string;
  type: string;
  title: string;
  description?: string;
  default?: unknown;
  enum?: unknown[];
  format?: string;
  secret: boolean;
  hasValue: boolean;
  value?: unknown;
  unreadable?: boolean;
}

/** Generated from the extension's settings schema. Secrets are write-only: blank keeps the stored value, "Clear" removes it. */
export function SettingsForm({ name, canWrite }: { name: string; canWrite: boolean }) {
  const toast = useToast();
  const [fields, setFields] = useState<Field[] | null>(null);
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [clear, setClear] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    try {
      const r = await api<{ fields: Field[] }>('GET', `/api/admin/extensions/${name}/settings`);
      setFields(r.fields);
      setValues(
        Object.fromEntries(
          r.fields
            .filter((f) => !f.secret)
            .map((f) => [f.key, f.value ?? f.default ?? (f.type === 'boolean' ? false : '')]),
        ),
      );
      setClear(new Set());
    } catch (e) {
      setError((e as Error).message);
    }
  }
  useEffect(() => {
    void load();
  }, [name]);

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!fields) return;
    const patch: Record<string, string | number | boolean | null> = {};
    for (const f of fields) {
      const v = values[f.key];
      if (f.secret) {
        if (clear.has(f.key)) patch[f.key] = null;
        else if (typeof v === 'string' && v !== '') patch[f.key] = v;
      } else if (f.type === 'number' || f.type === 'integer') {
        patch[f.key] = v === '' || v === undefined ? null : Number(v);
      } else if (f.type === 'boolean') {
        patch[f.key] = v === true;
      } else {
        patch[f.key] = v === '' || v === undefined ? null : String(v);
      }
    }
    setBusy(true);
    setError(null);
    try {
      await api('PUT', `/api/admin/extensions/${name}/settings`, patch);
      toast('Settings saved');
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (error && !fields)
    return (
      <div className="alert" role="alert">
        {error}
      </div>
    );
  if (!fields) return <p className="muted">Loading…</p>;
  return (
    <form className="card" onSubmit={save} style={{ maxWidth: 720 }}>
      <div className="card-b">
        {error ? (
          <div className="alert" role="alert">
            {error}
          </div>
        ) : null}
        {fields.map((f) => {
          const id = `s-${f.key}`;
          const v = values[f.key];
          return (
            <div className="field" key={f.key}>
              {f.type === 'boolean' ? (
                <label className="row" htmlFor={id}>
                  <input
                    id={id}
                    type="checkbox"
                    checked={v === true}
                    disabled={!canWrite}
                    onChange={(e) => setValues({ ...values, [f.key]: e.target.checked })}
                  />{' '}
                  <strong>{f.title}</strong>
                </label>
              ) : (
                <>
                  <label htmlFor={id}>{f.title}</label>
                  {f.enum ? (
                    <select
                      id={id}
                      className="select"
                      value={String(v ?? '')}
                      disabled={!canWrite}
                      onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
                    >
                      {f.enum.map((o) => (
                        <option key={String(o)}>{String(o)}</option>
                      ))}
                    </select>
                  ) : f.secret ? (
                    <div className="row">
                      <input
                        id={id}
                        className="input"
                        style={{ maxWidth: 360 }}
                        type="password"
                        autoComplete="new-password"
                        placeholder={
                          f.unreadable
                            ? 'Stored value cannot be read: enter it again'
                            : f.hasValue
                              ? 'Stored: leave blank to keep'
                              : 'Not set'
                        }
                        disabled={!canWrite || clear.has(f.key)}
                        value={typeof v === 'string' ? v : ''}
                        onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
                      />
                      {f.hasValue ? (
                        <label className="row" style={{ gap: 6 }}>
                          <input
                            type="checkbox"
                            checked={clear.has(f.key)}
                            disabled={!canWrite}
                            onChange={(e) => {
                              const n = new Set(clear);
                              if (e.target.checked) n.add(f.key);
                              else n.delete(f.key);
                              setClear(n);
                            }}
                          />
                          Clear
                        </label>
                      ) : null}
                    </div>
                  ) : (
                    <input
                      id={id}
                      className="input"
                      style={{ maxWidth: 480 }}
                      type={
                        f.type === 'number' || f.type === 'integer'
                          ? 'number'
                          : f.format === 'url'
                            ? 'url'
                            : 'text'
                      }
                      value={String(v ?? '')}
                      disabled={!canWrite}
                      onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
                    />
                  )}
                </>
              )}
              {f.description ? <span className="hint">{f.description}</span> : null}
            </div>
          );
        })}
        <button className="btn primary" disabled={busy || !canWrite}>
          {busy ? 'Saving…' : 'Save settings'}
        </button>
      </div>
    </form>
  );
}
