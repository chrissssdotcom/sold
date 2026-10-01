import Link from 'next/link';
import type { ReactNode } from 'react';
import instanceConfig from '../../../../../../sold.config';
import { allowed, requireStaff } from '../../../server/admin/session';
import { Nav, SignOut, type NavItem } from '../_components/nav';
import { ToastProvider } from '../_components/toast';

const ITEMS: (NavItem & { permission: string })[] = [
  {
    href: '/admin',
    label: 'Dashboard',
    icon: 'home',
    group: 'Overview',
    permission: 'reports:read',
  },
  { href: '/admin/orders', label: 'Orders', icon: 'bag', group: 'Sell', permission: 'orders:read' },
  {
    href: '/admin/products',
    label: 'Products',
    icon: 'box',
    group: 'Sell',
    permission: 'catalog:read',
  },
  {
    href: '/admin/promotions',
    label: 'Promotions',
    icon: 'tag',
    group: 'Sell',
    permission: 'promotions:read',
  },
  {
    href: '/admin/pages',
    label: 'Pages',
    icon: 'page',
    group: 'Storefront',
    permission: 'content:read',
  },
  {
    href: '/admin/theme',
    label: 'Theme',
    icon: 'brush',
    group: 'Storefront',
    permission: 'theme:read',
  },
  {
    href: '/admin/users',
    label: 'Staff & roles',
    icon: 'users',
    group: 'Settings',
    permission: 'users:read',
  },
  {
    href: '/admin/audit',
    label: 'Audit log',
    icon: 'log',
    group: 'Settings',
    permission: 'audit:read',
  },
];

export default async function Console({ children }: { children: ReactNode }) {
  const user = await requireStaff();
  const items = ITEMS.filter((i) => allowed(user, i.permission)).map(
    ({ permission: _p, ...rest }) => rest,
  );
  return (
    <ToastProvider>
      <a className="skip" href="#content">
        Skip to content
      </a>
      <div className="shell">
        <aside className="side">
          <Link className="brand" href="/admin">
            <i aria-hidden="true">S</i>
            {instanceConfig.instance.name}
          </Link>
          <Nav items={items} />
          <div className="me">
            <div style={{ fontWeight: 600 }}>{user.name || user.email}</div>
            <div className="muted" style={{ marginBottom: 8 }}>
              {user.email}
            </div>
            <SignOut />
          </div>
        </aside>
        <main id="content" className="main">
          {children}
        </main>
      </div>
    </ToastProvider>
  );
}
