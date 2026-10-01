import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import './admin.css';

export const metadata: Metadata = {
  title: { default: 'Admin', template: '%s · Admin' },
  robots: { index: false, follow: false },
};
export const viewport: Viewport = { width: 'device-width', initialScale: 1 };

/** Its own root layout: the console shares no markup, CSS or theme code with the storefront. */
export default function AdminRoot({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="admin">{children}</body>
    </html>
  );
}
