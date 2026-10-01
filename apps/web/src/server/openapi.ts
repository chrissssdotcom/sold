import { z } from 'zod';
import { errorOut, money, orderOut, orderSummary, productOut, stockIn } from './api-v1';

/** All component schemas in one registry, so shared parts (Money) become real `$ref`s into `#/components/schemas`, not nested `$defs`. */
const registry = z.registry<{ id: string }>();
const entries: [string, z.ZodType][] = [
  ['Money', money],
  ['Product', productOut],
  ['Order', orderOut],
  ['OrderSummary', orderSummary],
  ['StockUpdate', stockIn],
  ['Error', errorOut],
];
for (const [id, s] of entries) registry.add(s, { id });
const generated = z.toJSONSchema(registry, {
  io: 'output',
  unrepresentable: 'any',
  target: 'draft-2020-12',
  uri: (id) => `#/components/schemas/${id}`,
}).schemas as Record<string, Record<string, unknown>>;

const errors = (...codes: number[]) =>
  Object.fromEntries(
    codes.map((c) => [
      String(c),
      {
        description:
          {
            401: 'Missing or invalid API key',
            403: 'The key lacks the required scope',
            404: 'Not found',
            422: 'Invalid request',
            429: 'Rate limited (see Retry-After)',
          }[c] ?? 'Error',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
      },
    ]),
  );
const ok = (ref: string) => ({
  description: 'OK',
  content: { 'application/json': { schema: { $ref: `#/components/schemas/${ref}` } } },
});
const page = (ref: string) => ({
  description: 'OK',
  content: {
    'application/json': {
      schema: {
        type: 'object',
        required: ['items', 'nextCursor'],
        properties: {
          items: { type: 'array', items: { $ref: `#/components/schemas/${ref}` } },
          nextCursor: { type: ['string', 'null'] },
        },
      },
    },
  },
});
const sec = [{ bearerAuth: [] }];
const idParam = {
  name: 'id',
  in: 'path',
  required: true,
  schema: { type: 'string', format: 'uuid' },
};

/** The OpenAPI 3.1 document, generated from the same Zod schemas the routes use. A test checks every path here exists and answers. */
export function buildOpenApi(version: string) {
  return {
    openapi: '3.1.0',
    info: {
      title: 'Sold API',
      version,
      description:
        'Read catalogue and orders, update stock. Authenticate with an API key created in the admin console (Developers). Amounts are minor units as strings. Lists are cursor-paginated.',
    },
    servers: [{ url: '/api/v1' }],
    security: sec,
    paths: {
      '/products': {
        get: {
          operationId: 'listProducts',
          summary: 'List active products',
          tags: ['Catalogue'],
          'x-required-scope': 'catalog:read',
          parameters: [
            {
              name: 'limit',
              in: 'query',
              schema: { type: 'integer', minimum: 1, maximum: 50, default: 25 },
            },
            { name: 'cursor', in: 'query', schema: { type: 'string' } },
          ],
          responses: { '200': page('Product'), ...errors(401, 403, 429) },
        },
      },
      '/products/{id}': {
        get: {
          operationId: 'getProduct',
          summary: 'Get a product',
          tags: ['Catalogue'],
          'x-required-scope': 'catalog:read',
          parameters: [idParam],
          responses: { '200': ok('Product'), ...errors(401, 403, 404, 422, 429) },
        },
      },
      '/orders': {
        get: {
          operationId: 'listOrders',
          summary: 'List orders, newest first',
          tags: ['Orders'],
          'x-required-scope': 'orders:read',
          parameters: [
            { name: 'status', in: 'query', schema: { type: 'string' } },
            {
              name: 'limit',
              in: 'query',
              schema: { type: 'integer', minimum: 1, maximum: 50, default: 25 },
            },
            { name: 'before', in: 'query', schema: { type: 'string', format: 'uuid' } },
          ],
          responses: { '200': page('OrderSummary'), ...errors(401, 403, 429) },
        },
      },
      '/orders/{id}': {
        get: {
          operationId: 'getOrder',
          summary: 'Get an order with its lines',
          tags: ['Orders'],
          'x-required-scope': 'orders:read',
          parameters: [idParam],
          responses: { '200': ok('Order'), ...errors(401, 403, 404, 422, 429) },
        },
      },
      '/variants/{id}/stock': {
        put: {
          operationId: 'setStock',
          summary: 'Set on-hand stock for a variant',
          tags: ['Catalogue'],
          'x-required-scope': 'catalog:write',
          parameters: [idParam],
          requestBody: {
            required: true,
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/StockUpdate' } },
            },
          },
          responses: {
            '200': {
              description: 'OK',
              content: {
                'application/json': {
                  schema: { type: 'object', properties: { ok: { type: 'boolean' } } },
                },
              },
            },
            ...errors(401, 403, 404, 422, 429),
          },
        },
      },
    },
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          description: 'API key: sk_<prefix>_<secret>',
        },
      },
      schemas: generated,
    },
  };
}
