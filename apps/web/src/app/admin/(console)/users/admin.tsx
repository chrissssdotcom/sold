'use client';
import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '../../_components/api';
import { useToast } from '../../_components/toast';
import { Status, when } from '../../_components/ui';

interface Staff {
  id: string;
  email: string;
  name: string;
  status: string;
  lastLoginAt: string | null;
  roles: string[];
}
interface Role {
  name: string;
  description: string;
  permissions: string[];
  builtIn: boolean;
}

export function UsersAdmin(p: {
  me: string;
  staff: Staff[];
  roles: Role[];
  areas: Record<string, string[]>;
  canWrite: boolean;
  canRoles: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [perms, setPerms] = useState<Set<string>>(new Set());

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

  async function invite(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const role = String(f.get('role') ?? '');
    if (
      await run(
        () =>
          api('POST', '/api/admin/users', {
            email: String(f.get('email')),
            name: String(f.get('name')),
            password: String(f.get('password')),
            roles: role ? [role] : [],
          }),
        'Staff account created',
      )
    )
      form.reset();
  }
  async function newRole(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    if (
      await run(
        () =>
          api('POST', '/api/admin/roles', {
            name: String(f.get('name')),
            description: String(f.get('description')),
            permissions: [...perms],
          }),
        'Role created',
      )
    ) {
      form.reset();
      setPerms(new Set());
    }
  }

  return (
    <div className="grid" style={{ gap: 20 }}>
      <div className="card">
        <div className="card-h">
          <h2>Staff</h2>
        </div>
        <div className="table-wrap">
          <table className="t">
            <thead>
              <tr>
                <th>Person</th>
                <th>Roles</th>
                <th>Status</th>
                <th>Last sign-in</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {p.staff.map((s) => (
                <tr key={s.id}>
                  <td>
                    <strong>{s.name || s.email}</strong>
                    <div className="muted">{s.email}</div>
                  </td>
                  <td>
                    <div className="row" style={{ gap: 6 }}>
                      {s.roles.map((r) => (
                        <span key={r} className="badge info">
                          {r}
                          {p.canRoles ? (
                            <button
                              type="button"
                              aria-label={`Remove role ${r} from ${s.email}`}
                              className="btn sm ghost"
                              style={{ height: 18, padding: '0 4px' }}
                              disabled={busy}
                              onClick={() =>
                                run(
                                  () =>
                                    api(
                                      'DELETE',
                                      `/api/admin/users/${s.id}/roles/${encodeURIComponent(r)}`,
                                    ),
                                  'Role removed',
                                )
                              }
                            >
                              ×
                            </button>
                          ) : null}
                        </span>
                      ))}
                      {p.canRoles ? (
                        <select
                          className="select"
                          style={{ width: 130, minHeight: 28, padding: '2px 6px' }}
                          aria-label={`Add role to ${s.email}`}
                          value=""
                          onChange={(e) =>
                            e.target.value &&
                            run(
                              () =>
                                api(
                                  'PUT',
                                  `/api/admin/users/${s.id}/roles/${encodeURIComponent(e.target.value)}`,
                                ),
                              'Role added',
                            )
                          }
                        >
                          <option value="">Add role…</option>
                          {p.roles
                            .filter((r) => !s.roles.includes(r.name))
                            .map((r) => (
                              <option key={r.name}>{r.name}</option>
                            ))}
                        </select>
                      ) : null}
                    </div>
                  </td>
                  <td>
                    <Status value={s.status} />
                  </td>
                  <td className="muted">{when(s.lastLoginAt)}</td>
                  <td className="num">
                    {p.canWrite && s.id !== p.me ? (
                      <button
                        className="btn sm"
                        disabled={busy}
                        onClick={() =>
                          run(
                            () =>
                              api('PATCH', `/api/admin/users/${s.id}`, {
                                status: s.status === 'active' ? 'disabled' : 'active',
                              }),
                            s.status === 'active' ? 'Account disabled' : 'Account enabled',
                          )
                        }
                      >
                        {s.status === 'active' ? 'Disable' : 'Enable'}
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <div className="grid cols-2" style={{ alignItems: 'start' }}>
        {p.canWrite ? (
          <form className="card" onSubmit={invite}>
            <div className="card-h">
              <h2>Add staff</h2>
            </div>
            <div className="card-b">
              <div className="field">
                <label htmlFor="u-email">Email</label>
                <input id="u-email" name="email" type="email" className="input" required />
              </div>
              <div className="field">
                <label htmlFor="u-name">Name</label>
                <input id="u-name" name="name" className="input" />
              </div>
              <div className="field">
                <label htmlFor="u-pw">Initial password</label>
                <input
                  id="u-pw"
                  name="password"
                  type="password"
                  className="input"
                  autoComplete="new-password"
                  minLength={12}
                  required
                />
                <span className="hint">
                  At least 12 characters. Ask them to change it after first sign-in.
                </span>
              </div>
              <div className="field">
                <label htmlFor="u-role">Role</label>
                <select id="u-role" name="role" className="select">
                  <option value="">None</option>
                  {p.roles
                    .filter((r) => !r.permissions.includes('*'))
                    .map((r) => (
                      <option key={r.name}>{r.name}</option>
                    ))}
                </select>
              </div>
              <button className="btn primary" disabled={busy}>
                Create account
              </button>
            </div>
          </form>
        ) : null}
        <div className="card">
          <div className="card-h">
            <h2>Roles</h2>
          </div>
          <div className="table-wrap">
            <table className="t">
              <tbody>
                {p.roles.map((r) => (
                  <tr key={r.name}>
                    <td>
                      <strong>{r.name}</strong>{' '}
                      {r.builtIn ? <span className="badge">built-in</span> : null}
                      <div className="muted">{r.description}</div>
                      <div className="muted mono" style={{ marginTop: 4 }}>
                        {r.permissions.join(', ') || 'no permissions'}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        {p.canRoles ? (
          <form className="card" onSubmit={newRole}>
            <div className="card-h">
              <h2>New role</h2>
            </div>
            <div className="card-b">
              <div className="two">
                <div className="field">
                  <label htmlFor="r-name">Name</label>
                  <input
                    id="r-name"
                    name="name"
                    className="input"
                    required
                    pattern="[a-z0-9-]+"
                    title="lowercase letters, digits and dashes"
                  />
                </div>
                <div className="field">
                  <label htmlFor="r-desc">Description</label>
                  <input id="r-desc" name="description" className="input" />
                </div>
              </div>
              {Object.entries(p.areas).map(([area, actions]) => (
                <fieldset key={area} style={{ border: 0, padding: 0, margin: '0 0 8px' }}>
                  <legend style={{ fontWeight: 600 }}>{area}</legend>
                  <div className="row">
                    {actions.map((a) => {
                      const perm = `${area}:${a}`;
                      return (
                        <label key={perm} className="row" style={{ gap: 6 }}>
                          <input
                            type="checkbox"
                            checked={perms.has(perm)}
                            onChange={(e) => {
                              const n = new Set(perms);
                              if (e.target.checked) n.add(perm);
                              else n.delete(perm);
                              setPerms(n);
                            }}
                          />
                          {a}
                        </label>
                      );
                    })}
                  </div>
                </fieldset>
              ))}
              <button className="btn primary" disabled={busy || perms.size === 0}>
                Create role
              </button>
            </div>
          </form>
        ) : null}
      </div>
    </div>
  );
}
