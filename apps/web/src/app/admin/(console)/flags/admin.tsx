'use client';
import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '../../_components/api';
import { useToast } from '../../_components/toast';

interface Flag {
  key: string;
  enabled: boolean;
  description: string;
  rules: Record<string, unknown>;
}

const summary = (r: Record<string, unknown>) => {
  const parts: string[] = [];
  if (typeof r['rolloutPercent'] === 'number') parts.push(`${r['rolloutPercent']}% rollout`);
  if (Array.isArray(r['allowList']) && r['allowList'].length)
    parts.push(`${r['allowList'].length} always on`);
  if (Array.isArray(r['variants']) && r['variants'].length)
    parts.push(
      (r['variants'] as { name: string; weight: number }[])
        .map((v) => `${v.name}:${v.weight}`)
        .join(' / '),
    );
  return parts.join(' · ') || 'on for everyone when enabled';
};

export function FlagsAdmin({ flags, canWrite }: { flags: Flag[]; canWrite: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  async function save(flag: Flag, ok: string): Promise<boolean> {
    setBusy(true);
    try {
      await api('PUT', '/api/admin/flags', flag);
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
    const pct = String(f.get('pct') ?? '').trim();
    const variants = String(f.get('variants') ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((name) => ({ name, weight: 1 }));
    const rules: Record<string, unknown> = {};
    if (pct !== '') rules['rolloutPercent'] = Number(pct);
    if (variants.length) rules['variants'] = variants;
    const allow = String(f.get('allow') ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (allow.length) rules['allowList'] = allow;
    if (
      await save(
        {
          key: String(f.get('key')),
          enabled: false,
          description: String(f.get('description') ?? ''),
          rules,
        },
        'Flag created (off)',
      )
    )
      form.reset();
  }

  return (
    <div className="grid cols-2" style={{ alignItems: 'start' }}>
      <div className="card">
        <div className="table-wrap" tabIndex={0} role="region" aria-label="Flags">
          <table className="t">
            <thead>
              <tr>
                <th>Flag</th>
                <th>Rollout</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {flags.map((f) => (
                <tr key={f.key}>
                  <td>
                    <strong className="mono">{f.key}</strong>
                    <div className="muted">{f.description}</div>
                  </td>
                  <td className="muted">{summary(f.rules)}</td>
                  <td className="num">
                    <button
                      className={`btn sm${f.enabled ? '' : ' primary'}`}
                      disabled={!canWrite || busy}
                      onClick={() =>
                        save({ ...f, enabled: !f.enabled }, f.enabled ? 'Turned off' : 'Turned on')
                      }
                    >
                      {f.enabled ? 'Turn off' : 'Turn on'}
                    </button>
                  </td>
                </tr>
              ))}
              {flags.length === 0 ? (
                <tr>
                  <td colSpan={3} className="muted">
                    No flags yet.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </div>
      {canWrite ? (
        <form className="card" onSubmit={create}>
          <div className="card-h">
            <h2>New flag</h2>
          </div>
          <div className="card-b">
            <div className="field">
              <label htmlFor="fl-key">Key</label>
              <input
                id="fl-key"
                name="key"
                className="input mono"
                required
                pattern="[a-z][a-z0-9._-]+"
              />
            </div>
            <div className="field">
              <label htmlFor="fl-desc">What it controls</label>
              <input id="fl-desc" name="description" className="input" maxLength={300} />
            </div>
            <div className="two">
              <div className="field">
                <label htmlFor="fl-pct">Rollout %</label>
                <input
                  id="fl-pct"
                  name="pct"
                  className="input"
                  inputMode="decimal"
                  placeholder="blank = everyone"
                />
              </div>
              <div className="field">
                <label htmlFor="fl-var">Experiment arms</label>
                <input id="fl-var" name="variants" className="input" placeholder="control, new" />
              </div>
            </div>
            <div className="field">
              <label htmlFor="fl-allow">Always on for (ids, comma separated)</label>
              <input id="fl-allow" name="allow" className="input" />
            </div>
            <p className="muted">Created switched off. A visitor always sees the same arm.</p>
            <button className="btn primary" disabled={busy}>
              Create flag
            </button>
          </div>
        </form>
      ) : null}
    </div>
  );
}
