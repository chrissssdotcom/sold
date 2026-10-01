'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '../../_components/api';
import { useToast } from '../../_components/toast';

type Kind = 'color' | 'text';
const FIELDS: { key: string; label: string; kind: Kind; fallback: string; group: string }[] = [
  { key: '--bg', label: 'Page background', kind: 'color', fallback: '#faf6ef', group: 'Colour' },
  { key: '--surface', label: 'Card surface', kind: 'color', fallback: '#ffffff', group: 'Colour' },
  { key: '--ink', label: 'Text', kind: 'color', fallback: '#1f1a16', group: 'Colour' },
  { key: '--muted', label: 'Secondary text', kind: 'color', fallback: '#6a6056', group: 'Colour' },
  { key: '--line', label: 'Borders', kind: 'color', fallback: '#e4d9c8', group: 'Colour' },
  { key: '--accent', label: 'Brand accent', kind: 'color', fallback: '#a94a22', group: 'Brand' },
  {
    key: '--accent-hover',
    label: 'Accent (hover)',
    kind: 'color',
    fallback: '#8f3c19',
    group: 'Brand',
  },
  {
    key: '--accent-ink',
    label: 'Text on accent',
    kind: 'color',
    fallback: '#ffffff',
    group: 'Brand',
  },
  { key: '--r-sm', label: 'Small radius', kind: 'text', fallback: '10px', group: 'Shape' },
  { key: '--r-md', label: 'Medium radius', kind: 'text', fallback: '16px', group: 'Shape' },
  { key: '--r-lg', label: 'Large radius', kind: 'text', fallback: '28px', group: 'Shape' },
];

/** WCAG relative luminance contrast for #rrggbb pairs, so a poor accent choice is flagged before it ships. */
function contrast(a: string, b: string): number | null {
  const lum = (hex: string) => {
    const m = /^#([0-9a-f]{6})$/i.exec(hex);
    if (!m) return null;
    const c = [0, 2, 4]
      .map((i) => parseInt(m[1]!.slice(i, i + 2), 16) / 255)
      .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
  };
  const x = lum(a);
  const y = lum(b);
  if (x === null || y === null) return null;
  const [hi, lo] = x > y ? [x, y] : [y, x];
  return (hi + 0.05) / (lo + 0.05);
}

interface Loaded {
  themeName: string;
  base: Record<string, string>;
  tokens: Record<string, string>;
  version: number;
}

/** Loads the current settings (the active theme is only imported by the API route, never by this page's bundle), then renders the form. */
export function ThemeEditor({ canWrite }: { canWrite: boolean }) {
  const [data, setData] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<Loaded>('GET', '/api/admin/theme')
      .then(setData)
      .catch((e: Error) => setError(e.message));
  }, []);
  if (error)
    return (
      <div className="alert" role="alert">
        {error}
      </div>
    );
  if (!data) return <p className="muted">Loading theme…</p>;
  return (
    <ThemeForm
      themeName={data.themeName}
      base={data.base}
      saved={data.tokens}
      version={data.version}
      canWrite={canWrite}
    />
  );
}

function ThemeForm(p: {
  themeName: string;
  base: Record<string, string>;
  saved: Record<string, string>;
  version: number;
  canWrite: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const effective = (k: string, fb: string) => p.saved[k] ?? p.base[k] ?? fb;
  const [vals, setVals] = useState<Record<string, string>>(() =>
    Object.fromEntries(FIELDS.map((f) => [f.key, effective(f.key, f.fallback)])),
  );
  const [version, setVersion] = useState(p.version);
  const [busy, setBusy] = useState(false);

  const overrides = () =>
    Object.fromEntries(
      FIELDS.filter((f) => vals[f.key] !== (p.base[f.key] ?? f.fallback)).map((f) => [
        f.key,
        vals[f.key]!,
      ]),
    );
  const ratio = contrast(vals['--accent-ink']!, vals['--accent']!);
  const bodyRatio = contrast(vals['--ink']!, vals['--bg']!);

  async function save(tokens: Record<string, string>) {
    setBusy(true);
    try {
      const r = await api<{ version: number }>('PUT', '/api/admin/theme', {
        tokens,
        expectedVersion: version,
      });
      setVersion(r.version);
      toast('Theme saved. The storefront updates within a minute.');
      router.refresh();
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  }

  const groups = [...new Set(FIELDS.map((f) => f.group))];
  return (
    <div className="grid cols-2" style={{ alignItems: 'start' }}>
      <div className="card">
        <div className="card-h">
          <h2>Design tokens</h2>
          <span className="muted">Active theme: {p.themeName}</span>
        </div>
        <div className="card-b">
          {groups.map((g) => (
            <fieldset key={g} style={{ border: 0, padding: 0, margin: '0 0 8px' }}>
              <legend style={{ fontWeight: 650, marginBottom: 10 }}>{g}</legend>
              {FIELDS.filter((f) => f.group === g).map((f) => (
                <div className="field" key={f.key}>
                  <label htmlFor={`t${f.key}`}>{f.label}</label>
                  <div className="row">
                    {f.kind === 'color' && /^#[0-9a-f]{6}$/i.test(vals[f.key]!) ? (
                      <input
                        type="color"
                        className="swatch"
                        aria-label={`${f.label} colour picker`}
                        value={vals[f.key]}
                        disabled={!p.canWrite}
                        onChange={(e) => setVals({ ...vals, [f.key]: e.target.value })}
                      />
                    ) : null}
                    <input
                      id={`t${f.key}`}
                      className="input mono"
                      style={{ maxWidth: 180 }}
                      value={vals[f.key]}
                      disabled={!p.canWrite}
                      onChange={(e) => setVals({ ...vals, [f.key]: e.target.value })}
                    />
                    <span className="muted mono">{f.key}</span>
                  </div>
                </div>
              ))}
            </fieldset>
          ))}
          <div className="row">
            <button
              className="btn primary"
              disabled={busy || !p.canWrite}
              onClick={() => save(overrides())}
            >
              Save theme
            </button>
            <button
              className="btn"
              disabled={busy || !p.canWrite}
              onClick={() =>
                save({}).then(() =>
                  setVals(
                    Object.fromEntries(FIELDS.map((f) => [f.key, p.base[f.key] ?? f.fallback])),
                  ),
                )
              }
            >
              Reset to theme defaults
            </button>
          </div>
        </div>
      </div>
      <div className="grid">
        <div className="card">
          <div className="card-h">
            <h2>Preview</h2>
          </div>
          <div
            className="card-b"
            style={{
              background: vals['--bg'],
              color: vals['--ink'],
              borderRadius: `0 0 10px 10px`,
            }}
          >
            <div
              style={{
                background: vals['--surface'],
                border: `1px solid ${vals['--line']}`,
                borderRadius: vals['--r-md'],
                padding: 18,
              }}
            >
              <div style={{ fontSize: 20, fontWeight: 650 }}>Ember candle</div>
              <div style={{ color: vals['--muted'], margin: '4px 0 14px' }}>
                Hand-poured, slow-burning.
              </div>
              <span
                style={{
                  display: 'inline-block',
                  background: vals['--accent'],
                  color: vals['--accent-ink'],
                  padding: '10px 18px',
                  borderRadius: vals['--r-sm'],
                  fontWeight: 600,
                }}
              >
                Add to cart
              </span>
            </div>
          </div>
        </div>
        <div className="card">
          <div className="card-h">
            <h2>Accessibility check</h2>
          </div>
          <div className="card-b">
            {[
              ['Text on background', bodyRatio],
              ['Button text on accent', ratio],
            ].map(([label, r]) => (
              <div key={label as string} className="row between" style={{ marginBottom: 8 }}>
                <span>{label as string}</span>
                {r === null ? (
                  <span className="muted">use #rrggbb to check</span>
                ) : (
                  <span className={`badge ${(r as number) >= 4.5 ? 'ok' : 'bad'}`}>
                    {(r as number).toFixed(1)}:1{' '}
                    {(r as number) >= 4.5 ? 'passes AA' : 'fails AA (4.5:1)'}
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
