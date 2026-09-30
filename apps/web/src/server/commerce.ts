import {
  GatedReservationStrategy,
  InventoryGate,
  InventoryService,
  PostgresReservationStrategy,
  createCommerce,
  createShippingProvider,
  createTaxProvider,
  defaultShippingProvider,
  defaultTaxProvider,
  type Commerce,
} from '@sold/commerce';
import instanceConfig from '../../../../sold.config';
import { deriveCartKey } from './cart-token';
import { getCommerceMetrics } from './commerce-metrics';
import { getKernel } from './kernel';
import { getRuntime } from './runtime';

const LOCAL_DEV_ROOT = Buffer.alloc(32, 'sold-local-dev-key-not-a-secret').toString('base64');

interface Holder {
  commerce?: Promise<Commerce>;
  cartKey?: Buffer;
}
const holder = globalThis as unknown as { __soldCommerce?: Holder };
const slot: Holder = (holder.__soldCommerce ??= {});

/** The wired commerce domain for this process. Stateless: every fact lives in Postgres. */
export function getCommerce(): Promise<Commerce> {
  slot.commerce ??= build().catch((error) => {
    slot.commerce = undefined; // a failed boot is retried, not cached forever
    throw error;
  });
  return slot.commerce;
}

async function build(): Promise<Commerce> {
  const rt = getRuntime();
  const kernel = await getKernel();
  const cfg = instanceConfig.commerce;

  let inventoryStrategy = new PostgresReservationStrategy() as InstanceType<
    typeof PostgresReservationStrategy | typeof GatedReservationStrategy
  >;
  let inventoryGate: InventoryGate | undefined;
  if (cfg.inventoryGate) {
    if (!rt.redis) throw new Error('commerce.inventoryGate requires REDIS_URL');
    const reader = new InventoryService({ strategy: new PostgresReservationStrategy() });
    inventoryGate = new InventoryGate({
      redis: rt.redis,
      availability: async (variantId) => (await reader.level(rt.db.primary, variantId)).available,
      onEvent: (event) => getCommerceMetrics().inventoryGate.inc({ event }),
    });
    inventoryStrategy = new GatedReservationStrategy(
      new PostgresReservationStrategy(),
      inventoryGate,
    );
  }

  return createCommerce({
    hooks: kernel.interceptors,
    inventoryStrategy,
    ...(inventoryGate ? { inventoryGate } : {}),
    shipping: cfg.shipping
      ? createShippingProvider(cfg.shipping as never)
      : defaultShippingProvider,
    tax: cfg.tax ? createTaxProvider(cfg.tax as never) : defaultTaxProvider,
    checkout: {
      origin: cfg.origin,
      pricesIncludeTax: cfg.pricesIncludeTax,
      paymentWindowMinutes: cfg.paymentWindowMinutes,
    },
    onInvalidPromotion: (id, error) =>
      rt.log.error({ promotionId: id, err: error }, 'invalid stored promotion skipped'),
  });
}

/** Key for signing anonymous cart tokens. Derived from the instance secret; a public dev key only in `local`. */
export function cartKey(): Buffer {
  if (!slot.cartKey) {
    const env = getRuntime().env;
    const root =
      env.SOLD_SECRET_KEY ?? (env.SOLD_ENVIRONMENT === 'local' ? LOCAL_DEV_ROOT : undefined);
    if (!root) throw new Error('SOLD_SECRET_KEY is required to sign cart tokens');
    slot.cartKey = deriveCartKey(root);
  }
  return slot.cartKey;
}

export function cookiesAreSecure(): boolean {
  return getRuntime().env.SOLD_ENVIRONMENT !== 'local';
}
