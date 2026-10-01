import { json, readJson } from '../../../../../../server/commerce-http';
import { getCommerce } from '../../../../../../server/commerce';
import { apiRoute, lastSegment, stockIn } from '../../../../../../server/api-v1';
import { parseId } from '../../../../../../server/admin/http';
import { getRuntime } from '../../../../../../server/runtime';

export const dynamic = 'force-dynamic';

/** Set on-hand stock (e.g. from a warehouse system). Cannot go below what open orders have reserved. */
export const PUT = apiRoute('catalog:write', async (request, { key }) => {
  const variantId = parseId(lastSegment(request, 1));
  const v = stockIn.parse(await readJson(request));
  const { inventory } = await getCommerce();
  await inventory.setOnHand(
    getRuntime().db.primary,
    variantId,
    v.onHand,
    v.allowBackorder === undefined ? {} : { allowBackorder: v.allowBackorder },
  );
  getRuntime().log.info({ apiKey: key.name, variantId }, 'stock set through the API');
  return json({ ok: true });
});
