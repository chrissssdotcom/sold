'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { api } from './api';

const ICON = {
  home: 'M3 11l9-8 9 8v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z',
  box: 'M21 8l-9-5-9 5v8l9 5 9-5zM3 8l9 5 9-5M12 13v8',
  bag: 'M6 7h12l1 13H5zM9 7a3 3 0 0 1 6 0',
  page: 'M6 3h9l4 4v14H6zM14 3v5h5M9 13h7M9 17h7',
  tag: 'M3 12V4h8l10 10-8 8zM7.5 8.5h.01',
  brush: 'M14 4l6 6-8 8H6v-6zM4 20h8',
  users:
    'M16 19v-1a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v1M9.5 10a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7M21 19v-1a4 4 0 0 0-3-3.9M16 3.1a3.5 3.5 0 0 1 0 6.8',
  log: 'M5 4h14v16H5zM9 9h6M9 13h6M9 17h3',
  puzzle:
    'M10 4a2 2 0 1 1 4 0v2h4v4h-2a2 2 0 1 0 0 4h2v4h-4v-2a2 2 0 1 0-4 0v2H6v-4h2a2 2 0 1 0 0-4H6V6h4z',
} as const;

export interface NavItem {
  href: string;
  label: string;
  icon: keyof typeof ICON;
  group: string;
}

export function Nav({ items }: { items: NavItem[] }) {
  const path = usePathname();
  let last = '';
  return (
    <nav className="nav" aria-label="Admin">
      {items.map((i) => {
        const current = i.href === '/admin' ? path === '/admin' : path.startsWith(i.href);
        const header = i.group !== last ? <div className="group">{i.group}</div> : null;
        last = i.group;
        return (
          <span key={i.href} style={{ display: 'contents' }}>
            {header}
            <Link href={i.href} aria-current={current ? 'page' : undefined}>
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d={ICON[i.icon]} />
              </svg>
              {i.label}
            </Link>
          </span>
        );
      })}
    </nav>
  );
}

export function SignOut() {
  const router = useRouter();
  return (
    <button
      className="btn sm"
      onClick={async () => {
        await api('POST', '/api/admin/auth/logout').catch(() => undefined);
        router.replace('/admin/login');
        router.refresh();
      }}
    >
      Sign out
    </button>
  );
}
