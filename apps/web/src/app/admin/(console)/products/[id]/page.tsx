import { notFound } from 'next/navigation';
import { getCommerce } from '../../../../../server/commerce';
import { getRuntime } from '../../../../../server/runtime';
import { allowed, requireStaff } from '../../../../../server/admin/session';
import { PageHead, Status } from '../../../_components/ui';
import { ProductEditor } from './editor';

export const dynamic = 'force-dynamic';

export default async function ProductPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireStaff();
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  const { catalog, inventory } = await getCommerce();
  const db = getRuntime().db.primary;
  const product = await catalog.getById(db, id).catch(() => null);
  if (!product) notFound();
  const levels = await Promise.all(
    product.variants.map((v) => inventory.level(db, v.id).catch(() => null)),
  );
  const variants = product.variants.map((v, i) => ({
    id: v.id,
    sku: v.sku,
    title: v.title,
    options: v.options,
    onHand: levels[i]?.onHand ?? 0,
    reserved: levels[i]?.reserved ?? 0,
    allowBackorder: levels[i]?.allowBackorder ?? false,
    prices: v.prices.map((p) => ({ currency: p.currency, amount: p.amount.amount.toString() })),
  }));
  return (
    <>
      <PageHead
        title={product.title}
        crumbs={[{ label: 'Products', href: '/admin/products' }, { label: product.handle }]}
      >
        <Status value={product.status} />
      </PageHead>
      <ProductEditor
        id={product.id}
        status={product.status as 'draft' | 'active' | 'archived'}
        handle={product.handle}
        variants={variants}
        canWrite={allowed(user, 'catalog:write')}
        canPublish={allowed(user, 'catalog:publish')}
      />
    </>
  );
}
