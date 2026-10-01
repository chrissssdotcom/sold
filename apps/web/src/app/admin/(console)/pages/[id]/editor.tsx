'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, ApiError } from '../../../_components/api';
import { useToast } from '../../../_components/toast';
import { when } from '../../../_components/ui';
import { SchemaForm, seed, type JSchema } from './schema-form';

interface Node {
  id: string;
  type: string;
  props: Record<string, unknown>;
  children?: Node[];
}
interface BlockDef {
  type: string;
  title: string;
  description: string;
  category: string;
  container: boolean;
  defaultProps: Record<string, unknown>;
  schema: JSchema;
}
interface Version {
  id: string;
  version: number;
  note: string;
  by: string;
  at: string;
}

const newId = () => crypto.randomUUID().replace(/-/g, '').slice(0, 10);

// ---- pure tree helpers (immutable) ---------------------------------------------------------
function mapNode(tree: Node[], id: string, fn: (n: Node) => Node): Node[] {
  return tree.map((n) =>
    n.id === id ? fn(n) : n.children ? { ...n, children: mapNode(n.children, id, fn) } : n,
  );
}
function removeNode(tree: Node[], id: string): Node[] {
  return tree
    .filter((n) => n.id !== id)
    .map((n) => (n.children ? { ...n, children: removeNode(n.children, id) } : n));
}
function findNode(tree: Node[], id: string | null): Node | null {
  if (!id) return null;
  for (const n of tree) {
    if (n.id === id) return n;
    const hit = n.children ? findNode(n.children, id) : null;
    if (hit) return hit;
  }
  return null;
}
function moveNode(tree: Node[], id: string, delta: -1 | 1): Node[] {
  const i = tree.findIndex((n) => n.id === id);
  if (i >= 0) {
    const j = i + delta;
    if (j < 0 || j >= tree.length) return tree;
    const out = [...tree];
    [out[i], out[j]] = [out[j]!, out[i]!];
    return out;
  }
  return tree.map((n) => (n.children ? { ...n, children: moveNode(n.children, id, delta) } : n));
}
function addNode(tree: Node[], node: Node, parentId: string | null): Node[] {
  if (!parentId) return [...tree, node];
  return mapNode(tree, parentId, (p) => ({ ...p, children: [...(p.children ?? []), node] }));
}
function cloneWithNewIds(n: Node): Node {
  return {
    ...structuredClone(n),
    id: newId(),
    ...(n.children ? { children: n.children.map(cloneWithNewIds) } : {}),
  };
}
function duplicateNode(tree: Node[], id: string): Node[] {
  const i = tree.findIndex((n) => n.id === id);
  if (i >= 0) {
    const out = [...tree];
    out.splice(i + 1, 0, cloneWithNewIds(tree[i]!));
    return out;
  }
  return tree.map((n) => (n.children ? { ...n, children: duplicateNode(n.children, id) } : n));
}

export function Editor(p: {
  pageId: string;
  locale: string;
  path: string;
  initialTree: Node[];
  initialVersion: number;
  publishedVersionId: string | null;
  versions: Version[];
  canWrite: boolean;
  canPublish: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [tree, setTree] = useState<Node[]>(p.initialTree);
  const [version, setVersion] = useState(p.initialVersion);
  const [selected, setSelected] = useState<string | null>(null);
  const [blocks, setBlocks] = useState<BlockDef[]>([]);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [mobile, setMobile] = useState(false);
  const [frameKey, setFrameKey] = useState(0);
  const [issues, setIssues] = useState<{ path: string; message: string }[]>([]);
  const [previewVersion, setPreviewVersion] = useState<number | null>(null);
  const [tab, setTab] = useState<'edit' | 'history'>('edit');
  const frame = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    api<BlockDef[]>('GET', '/api/admin/blocks')
      .then(setBlocks)
      .catch((e: Error) => toast(e.message, true));
  }, [toast]);

  // Leaving with unsaved edits asks first.
  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [dirty]);

  const byType = useMemo(() => new Map(blocks.map((b) => [b.type, b])), [blocks]);
  const sel = findNode(tree, selected);
  const selDef = sel ? byType.get(sel.type) : undefined;
  const change = (next: Node[]) => {
    setTree(next);
    setDirty(true);
  };

  const add = (def: BlockDef) => {
    const parent = sel && byType.get(sel.type)?.container ? sel.id : null;
    const node: Node = { id: newId(), type: def.type, props: structuredClone(def.defaultProps) };
    if (def.container) node.children = [];
    change(addNode(tree, node, parent));
    setSelected(node.id);
  };

  const save = useCallback(async (): Promise<boolean> => {
    setBusy(true);
    setIssues([]);
    try {
      const r = await api<{ version: number }>('PUT', `/api/admin/pages/${p.pageId}`, {
        tree,
        expectedVersion: version,
        note: 'edited in the page builder',
      });
      setVersion(r.version);
      setDirty(false);
      setPreviewVersion(null);
      setFrameKey((k) => k + 1);
      toast(`Saved as version ${r.version} (not live yet)`);
      router.refresh();
      return true;
    } catch (e) {
      if (e instanceof ApiError && e.code === 'invalid_page_tree')
        setIssues((e.details as { issues: { path: string; message: string }[] }).issues);
      toast((e as Error).message, true);
      return false;
    } finally {
      setBusy(false);
    }
  }, [p.pageId, tree, version, toast, router]);

  /** Make a saved version live. Rolling back is the same call with an older version. */
  const publishVersion = async (v: number) => {
    setBusy(true);
    try {
      await api('POST', `/api/admin/pages/${p.pageId}/publish`, { version: v });
      toast(`Version ${v} is live`);
      router.refresh();
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };

  const src = `/${p.locale}/preview/${p.pageId}${previewVersion ? `?v=${previewVersion}` : ''}`;
  const liveVersion = p.versions.find((v) => v.id === p.publishedVersionId)?.version ?? null;
  const roots = tree;

  const renderTree = (nodes: Node[]) => (
    <ul className={nodes === roots ? 'tree' : 'kids'}>
      {nodes.map((n) => (
        <li key={n.id}>
          <button
            type="button"
            className="node"
            aria-pressed={selected === n.id}
            onClick={() => setSelected(n.id)}
          >
            <strong>{byType.get(n.type)?.title ?? n.type}</strong>
            {!byType.has(n.type) && blocks.length > 0 ? (
              <span className="badge bad">unknown</span>
            ) : null}
          </button>
          {n.children?.length ? renderTree(n.children) : null}
        </li>
      ))}
    </ul>
  );

  return (
    <div className="grid" style={{ gap: 16 }}>
      <div className="card">
        <div className="card-b row between" style={{ padding: '12px 18px' }}>
          <div className="row">
            <span className="muted">
              Version {version}
              {liveVersion ? ` · live: v${liveVersion}` : ' · not published'}
              {dirty ? ' · unsaved changes' : ''}
            </span>
          </div>
          <div className="row">
            <div className="row" role="group" aria-label="Preview width">
              <button
                type="button"
                className="btn sm"
                aria-pressed={!mobile}
                onClick={() => setMobile(false)}
              >
                Desktop
              </button>
              <button
                type="button"
                className="btn sm"
                aria-pressed={mobile}
                onClick={() => setMobile(true)}
              >
                Mobile
              </button>
            </div>
            <button
              type="button"
              className="btn"
              disabled={busy || !p.canWrite || !dirty}
              onClick={save}
            >
              Save draft
            </button>
            <button
              type="button"
              className="btn primary"
              disabled={busy || !p.canPublish || dirty || version === liveVersion}
              title={dirty ? 'Save first' : p.canPublish ? '' : 'Needs content:publish'}
              onClick={() => publishVersion(version)}
            >
              Publish v{version}
            </button>
          </div>
        </div>
      </div>
      {issues.length > 0 ? (
        <div className="alert" role="alert">
          <strong>This page cannot be saved yet:</strong>
          <ul style={{ margin: '6px 0 0 18px', padding: 0 }}>
            {issues.slice(0, 8).map((i) => (
              <li key={i.path + i.message}>
                <span className="mono">{i.path}</span> {i.message}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <div className="editor">
        <aside className="card panel" aria-label="Blocks">
          <div className="card-h">
            <h2>Blocks</h2>
            {selected ? (
              <button type="button" className="btn sm ghost" onClick={() => setSelected(null)}>
                Deselect
              </button>
            ) : null}
          </div>
          {tree.length === 0 ? (
            <div className="empty">Empty page. Add a block below.</div>
          ) : (
            renderTree(tree)
          )}
          {p.canWrite ? (
            <>
              <div className="card-h" style={{ borderTop: '1px solid var(--a-line)' }}>
                <h2>Add block</h2>
                <span className="muted">
                  {sel && selDef?.container ? 'into selected' : 'at the end'}
                </span>
              </div>
              <div className="picker">
                {blocks.map((b) => (
                  <button key={b.type} type="button" onClick={() => add(b)}>
                    <strong>{b.title}</strong>
                    <span className="muted">{b.description || b.category}</span>
                  </button>
                ))}
              </div>
            </>
          ) : null}
        </aside>
        <section aria-label="Preview">
          <iframe
            key={frameKey}
            ref={frame}
            title="Page preview"
            className={`preview-frame${mobile ? ' mobile' : ''}`}
            src={src}
          />
          <p className="muted" style={{ marginTop: 8 }}>
            {previewVersion
              ? `Previewing version ${previewVersion}. `
              : 'Previewing the latest saved version. '}
            Save to refresh the preview.
          </p>
        </section>
        <aside className="card panel" aria-label="Settings">
          <div className="tabs" role="tablist" style={{ padding: '0 12px', marginBottom: 0 }}>
            <button role="tab" aria-selected={tab === 'edit'} onClick={() => setTab('edit')}>
              Block
            </button>
            <button role="tab" aria-selected={tab === 'history'} onClick={() => setTab('history')}>
              History
            </button>
          </div>
          {tab === 'edit' ? (
            <div className="card-b">
              {!sel ? (
                <p className="muted">Select a block to edit it.</p>
              ) : (
                <>
                  <div className="row between" style={{ marginBottom: 12 }}>
                    <h2>{selDef?.title ?? sel.type}</h2>
                    <div className="row">
                      <button
                        type="button"
                        className="btn sm"
                        aria-label="Move up"
                        disabled={!p.canWrite}
                        onClick={() => change(moveNode(tree, sel.id, -1))}
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        className="btn sm"
                        aria-label="Move down"
                        disabled={!p.canWrite}
                        onClick={() => change(moveNode(tree, sel.id, 1))}
                      >
                        ↓
                      </button>
                      <button
                        type="button"
                        className="btn sm"
                        disabled={!p.canWrite}
                        onClick={() => change(duplicateNode(tree, sel.id))}
                      >
                        Duplicate
                      </button>
                      <button
                        type="button"
                        className="btn sm danger"
                        disabled={!p.canWrite}
                        onClick={() => {
                          change(removeNode(tree, sel.id));
                          setSelected(null);
                        }}
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                  {selDef ? (
                    <SchemaForm
                      key={sel.id}
                      schema={selDef.schema}
                      value={sel.props}
                      onChange={(next) =>
                        change(
                          mapNode(tree, sel.id, (n) => ({
                            ...n,
                            props: (next ?? seed(selDef.schema)) as Record<string, unknown>,
                          })),
                        )
                      }
                    />
                  ) : (
                    <p className="alert">
                      This block type is not available (its extension may be disabled). It is
                      skipped on the live page.
                    </p>
                  )}
                </>
              )}
            </div>
          ) : (
            <ul className="tree">
              {p.versions.map((v) => (
                <li key={v.id} className="list-item">
                  <div className="row between">
                    <strong>v{v.version}</strong>
                    {v.id === p.publishedVersionId ? <span className="badge ok">live</span> : null}
                  </div>
                  <div className="muted">
                    {v.by} · {when(v.at)}
                  </div>
                  <div className="row" style={{ marginTop: 8 }}>
                    <button
                      type="button"
                      className="btn sm"
                      onClick={() => setPreviewVersion(v.version)}
                    >
                      Preview
                    </button>
                    <button
                      type="button"
                      className="btn sm"
                      disabled={busy || !p.canPublish || v.id === p.publishedVersionId || dirty}
                      onClick={() => publishVersion(v.version)}
                    >
                      {v.version < version ? 'Roll back to this' : 'Publish'}
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </aside>
      </div>
    </div>
  );
}
