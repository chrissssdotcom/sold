import { json } from '../../../../../server/commerce-http';
import { getCommerce } from '../../../../../server/commerce';
import { apiRoute, lastSegment, moneyJson } from '../../../../../server/api-v1';
import { parseId } from '../../../../../server/admin/http';
import { getRuntime } from '../../../../../server/runtime';

export const dynamic = 'force-dynamic';

export const GET = apiRoute('orders:read', async (request) => {
  const { orders } = await getCommerce();
  const o = await orders.get(getRuntime().db.primary, parseId(lastSegment(request)));
  return json({
    id: o.id,
    number: o.number,
    status: o.status,
    email: o.email,
    placedAt: o.placedAt.toISOString(),
    subtotal: moneyJson(o.subtotal),
    discountTotal: moneyJson(o.discountTotal),
    shippingTotal: moneyJson(o.shippingTotal),
    taxTotal: moneyJson(o.taxTotal),
    total: moneyJson(o.total),
    lines: o.lines.map((l) => ({
      sku: l.sku,
      title: l.title,
      quantity: l.quantity,
      unitPrice: moneyJson(l.unitPrice),
      lineTotal: moneyJson(l.lineTotal),
    })),
  });
});
