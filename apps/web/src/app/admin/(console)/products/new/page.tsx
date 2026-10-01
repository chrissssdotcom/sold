import { redirect } from 'next/navigation';
import { allowed, requireStaff } from '../../../../../server/admin/session';
import { PageHead } from '../../../_components/ui';
import { NewProductForm } from './form';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Add product' };

export default async function NewProduct() {
  const user = await requireStaff();
  if (!allowed(user, 'catalog:write')) redirect('/admin/products');
  return (
    <>
      <PageHead
        title="Add product"
        crumbs={[{ label: 'Products', href: '/admin/products' }, { label: 'New' }]}
      />
      <NewProductForm />
    </>
  );
}
