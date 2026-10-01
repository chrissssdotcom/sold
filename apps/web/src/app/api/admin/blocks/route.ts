import { adminRoute } from '../../../../server/admin-route';
import { json } from '../../../../server/commerce-http';
import { z as zod } from 'zod';
import { blockRegistry } from '../../../../storefront/theme';

export const dynamic = 'force-dynamic';
/** The block catalogue for the editor: type, title, defaults and a JSON Schema generated from the same Zod schema that validates saves. */
export const GET = adminRoute('content:read', async () =>
  json(
    blockRegistry()
      .list()
      .map(({ def, container }) => ({
        type: def.type,
        title: def.title,
        description: def.description ?? '',
        category: def.category ?? 'general',
        container,
        defaultProps: def.defaultProps,
        schema: zod.toJSONSchema(def.propsSchema, { unrepresentable: 'any', io: 'input' }),
      })),
  ),
);
