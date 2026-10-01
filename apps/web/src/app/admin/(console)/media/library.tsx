'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../_components/api';
import { useToast } from '../../_components/toast';

export interface Asset {
  id: string;
  originalName: string;
  width: number;
  height: number;
  bytes: number;
  alt: string;
  url: string;
}

/** The library grid, reused by the page-builder image picker (`onPick`). */
export function MediaLibrary({
  canWrite,
  onPick,
}: {
  canWrite: boolean;
  onPick?: (asset: Asset) => void;
}) {
  const toast = useToast();
  const [items, setItems] = useState<Asset[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const load = useCallback(async (before?: string) => {
    const r = await api<{ items: Asset[]; nextCursor: string | null }>(
      'GET',
      `/api/admin/media?limit=24${before ? `&before=${before}` : ''}`,
    );
    setItems((cur) => (before ? [...(cur ?? []), ...r.items] : r.items));
    setCursor(r.nextCursor);
  }, []);
  useEffect(() => {
    load().catch((e: Error) => toast(e.message, true));
  }, [load, toast]);

  async function upload(files: FileList | null) {
    if (!files?.length) return;
    setBusy(true);
    try {
      for (const file of Array.from(files)) {
        const res = await fetch(`/api/admin/media?name=${encodeURIComponent(file.name)}`, {
          method: 'POST',
          body: file,
          credentials: 'same-origin',
          headers: { 'content-type': file.type || 'application/octet-stream' },
        });
        const out = (await res.json()) as { error?: { message?: string }; created?: boolean };
        if (!res.ok) toast(`${file.name}: ${out.error?.message ?? 'upload failed'}`, true);
        else if (out.created === false) toast(`${file.name} was already in the library`);
      }
      await load();
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  }

  return (
    <div className="card">
      {canWrite ? (
        <div className="card-h">
          <label className="btn primary" style={{ cursor: busy ? 'wait' : 'pointer' }}>
            {busy ? 'Uploading…' : 'Upload images'}
            <input
              ref={input}
              type="file"
              accept="image/jpeg,image/png,image/webp,image/gif,image/avif"
              multiple
              disabled={busy}
              className="sr-only"
              onChange={(e) => void upload(e.target.files)}
            />
          </label>
          <span className="muted">
            JPEG, PNG, WebP, GIF or AVIF, up to 12 MB. Re-encoded; location and camera data removed.
          </span>
        </div>
      ) : null}
      <div className="card-b">
        {items === null ? (
          <p className="muted">Loading…</p>
        ) : items.length === 0 ? (
          <p className="muted">No images yet.</p>
        ) : null}
        <ul
          style={{
            listStyle: 'none',
            padding: 0,
            margin: 0,
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))',
            gap: 14,
          }}
        >
          {items?.map((a) => (
            <li key={a.id} className="list-item" style={{ margin: 0 }}>
              <img
                src={a.url}
                alt={a.alt}
                width={a.width}
                height={a.height}
                loading="lazy"
                style={{
                  width: '100%',
                  aspectRatio: '4/3',
                  objectFit: 'cover',
                  borderRadius: 6,
                  background: 'var(--a-line)',
                }}
              />
              <div className="muted" style={{ fontSize: 12, margin: '6px 0' }}>
                {a.originalName} · {a.width}×{a.height}
              </div>
              {onPick ? (
                <button type="button" className="btn sm primary" onClick={() => onPick(a)}>
                  Use this image
                </button>
              ) : (
                <>
                  <label className="sr-only" htmlFor={`alt-${a.id}`}>
                    Alt text for {a.originalName}
                  </label>
                  <input
                    id={`alt-${a.id}`}
                    className="input"
                    placeholder="Describe the image"
                    defaultValue={a.alt}
                    disabled={!canWrite}
                    maxLength={300}
                    onBlur={(e) => {
                      if (e.target.value !== a.alt)
                        api('PATCH', `/api/admin/media/${a.id}`, { alt: e.target.value })
                          .then(() => toast('Alt text saved'))
                          .catch((err: Error) => toast(err.message, true));
                    }}
                  />
                  <div className="row" style={{ marginTop: 8 }}>
                    <button
                      type="button"
                      className="btn sm"
                      onClick={() =>
                        navigator.clipboard.writeText(a.url).then(() => toast('URL copied'))
                      }
                    >
                      Copy URL
                    </button>
                    {canWrite ? (
                      <button
                        type="button"
                        className="btn sm danger"
                        onClick={() => {
                          if (
                            !confirm(
                              `Delete ${a.originalName}? Pages that use it will show a broken image.`,
                            )
                          )
                            return;
                          api('DELETE', `/api/admin/media/${a.id}`)
                            .then(() => setItems((cur) => (cur ?? []).filter((x) => x.id !== a.id)))
                            .catch((err: Error) => toast(err.message, true));
                        }}
                      >
                        Delete
                      </button>
                    ) : null}
                  </div>
                </>
              )}
            </li>
          ))}
        </ul>
        {cursor ? (
          <p>
            <button className="btn" onClick={() => void load(cursor)}>
              Load more
            </button>
          </p>
        ) : null}
      </div>
    </div>
  );
}
