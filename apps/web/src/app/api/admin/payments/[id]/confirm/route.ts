import { adminRoute } from '../../../../../../server/admin-route';
import { json } from '../../../../../../server/commerce-http';
import { parseId } from '../../../../../../server/admin/http';
import { getCommerce } from '../../../../../../server/commerce';
import { getRuntime } from '../../../../../../server/runtime';
import { getPaymentsFor } from '../../../../../../server/payments';

export const dynamic = 'force-dynamic';
/** Staff confirm that a manual payment (bank transfer, cash on delivery) arrived. */
export const POST = adminRoute('orders:write', async (req, { db, audit, user }) => {
  const parts = new URL(req.url).pathname.split('/');
  const paymentId = parseId(parts[parts.length - 2]);
  const payments = getPaymentsFor(getRuntime().env, await getCommerce());
  const outcome = await payments.confirmManually(db, paymentId, user.email);
  await audit('payment.confirm', { type: 'payment', id: paymentId }, { outcome });
  return json({ outcome });
});
