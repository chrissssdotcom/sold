import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  char,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

const id = () =>
  uuid('id')
    .primaryKey()
    .default(sql`sold_uuid_v7()`);
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();
/** Money is always bigint minor units (paired with an ISO-4217 code column). */
const minor = (name: string) => bigint(name, { mode: 'bigint' });

export const products = pgTable('products', {
  id: id(),
  handle: text('handle').notNull().unique('products_handle_key'),
  title: text('title').notNull(),
  description: text('description').notNull().default(''),
  status: text('status').notNull().default('draft'),
  tags: text('tags')
    .array()
    .notNull()
    .default(sql`'{}'`),
  attributes: jsonb('attributes')
    .notNull()
    .default(sql`'{}'::jsonb`),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const productVariants = pgTable(
  'product_variants',
  {
    id: id(),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    sku: text('sku').notNull().unique('product_variants_sku_key'),
    title: text('title').notNull().default(''),
    options: jsonb('options')
      .notNull()
      .default(sql`'{}'::jsonb`),
    weightGrams: integer('weight_grams').notNull().default(0),
    position: integer('position').notNull().default(0),
    status: text('status').notNull().default('active'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('product_variants_product_idx').on(t.productId, t.position)],
);

export const variantPrices = pgTable(
  'variant_prices',
  {
    variantId: uuid('variant_id')
      .notNull()
      .references(() => productVariants.id, { onDelete: 'cascade' }),
    currency: char('currency', { length: 3 }).notNull(),
    amount: minor('amount').notNull(),
    compareAt: minor('compare_at'),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.variantId, t.currency] })],
);

export const inventoryLevels = pgTable('inventory_levels', {
  variantId: uuid('variant_id')
    .primaryKey()
    .references(() => productVariants.id, { onDelete: 'cascade' }),
  onHand: integer('on_hand').notNull().default(0),
  reserved: integer('reserved').notNull().default(0),
  allowBackorder: boolean('allow_backorder').notNull().default(false),
  updatedAt: updatedAt(),
});

export const inventoryReservations = pgTable(
  'inventory_reservations',
  {
    id: id(),
    variantId: uuid('variant_id')
      .notNull()
      .references(() => productVariants.id, { onDelete: 'cascade' }),
    ownerRef: text('owner_ref').notNull(),
    quantity: integer('quantity').notNull(),
    status: text('status').notNull().default('held'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: createdAt(),
    settledAt: timestamp('settled_at', { withTimezone: true }),
  },
  (t) => [index('inventory_reservations_variant_idx').on(t.variantId)],
);

export const carts = pgTable('carts', {
  id: id(),
  customerId: uuid('customer_id'),
  currency: char('currency', { length: 3 }).notNull(),
  status: text('status').notNull().default('open'),
  version: integer('version').notNull().default(1),
  couponCodes: text('coupon_codes')
    .array()
    .notNull()
    .default(sql`'{}'`),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const cartLines = pgTable(
  'cart_lines',
  {
    id: id(),
    cartId: uuid('cart_id')
      .notNull()
      .references(() => carts.id, { onDelete: 'cascade' }),
    variantId: uuid('variant_id')
      .notNull()
      .references(() => productVariants.id, { onDelete: 'restrict' }),
    quantity: integer('quantity').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('cart_lines_variant_idx').on(t.variantId)],
);

export const orders = pgTable('orders', {
  id: id(),
  number: bigint('number', { mode: 'bigint' })
    .notNull()
    .default(sql`nextval('order_number_seq')`),
  cartId: uuid('cart_id').references(() => carts.id, { onDelete: 'restrict' }),
  customerId: uuid('customer_id'),
  email: text('email').notNull(),
  status: text('status').notNull().default('pending_payment'),
  currency: char('currency', { length: 3 }).notNull(),
  subtotal: minor('subtotal').notNull(),
  discountTotal: minor('discount_total').notNull().default(0n),
  shippingTotal: minor('shipping_total').notNull().default(0n),
  taxTotal: minor('tax_total').notNull().default(0n),
  total: minor('total').notNull(),
  pricing: jsonb('pricing')
    .notNull()
    .default(sql`'{}'::jsonb`),
  shippingAddress: jsonb('shipping_address').notNull(),
  billingAddress: jsonb('billing_address').notNull(),
  shippingMethod: text('shipping_method'),
  placedAt: timestamp('placed_at', { withTimezone: true }).notNull().defaultNow(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const orderLines = pgTable(
  'order_lines',
  {
    id: id(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    variantId: uuid('variant_id').references(() => productVariants.id, { onDelete: 'set null' }),
    sku: text('sku').notNull(),
    title: text('title').notNull(),
    quantity: integer('quantity').notNull(),
    unitPrice: minor('unit_price').notNull(),
    discount: minor('discount').notNull().default(0n),
    tax: minor('tax').notNull().default(0n),
    lineTotal: minor('line_total').notNull(),
  },
  (t) => [index('order_lines_order_idx').on(t.orderId)],
);

export const orderStatusHistory = pgTable(
  'order_status_history',
  {
    id: id(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    fromStatus: text('from_status'),
    toStatus: text('to_status').notNull(),
    actor: text('actor').notNull(),
    reason: text('reason').notNull().default(''),
    createdAt: createdAt(),
  },
  (t) => [index('order_status_history_order_idx').on(t.orderId, t.createdAt)],
);

export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    scope: text('scope').notNull(),
    key: text('key').notNull(),
    requestHash: text('request_hash').notNull(),
    status: text('status').notNull().default('in_progress'),
    response: jsonb('response'),
    createdAt: createdAt(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => [primaryKey({ columns: [t.scope, t.key] })],
);

export const promotions = pgTable('promotions', {
  id: id(),
  code: text('code'),
  name: text('name').notNull(),
  active: boolean('active').notNull().default(true),
  startsAt: timestamp('starts_at', { withTimezone: true }),
  endsAt: timestamp('ends_at', { withTimezone: true }),
  definition: jsonb('definition').notNull(),
  usageLimit: integer('usage_limit'),
  perCustomerLimit: integer('per_customer_limit'),
  usageCount: integer('usage_count').notNull().default(0),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const promotionRedemptions = pgTable(
  'promotion_redemptions',
  {
    id: id(),
    promotionId: uuid('promotion_id')
      .notNull()
      .references(() => promotions.id, { onDelete: 'restrict' }),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    customerKey: text('customer_key').notNull(),
    amount: minor('amount').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('promotion_redemptions_order_idx').on(t.orderId)],
);

export const payments = pgTable(
  'payments',
  {
    id: id(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'restrict' }),
    gateway: text('gateway').notNull(),
    gatewayRef: text('gateway_ref'),
    status: text('status').notNull().default('pending'),
    currency: char('currency', { length: 3 }).notNull(),
    amount: minor('amount').notNull(),
    captured: minor('captured').notNull().default(0n),
    refunded: minor('refunded').notNull().default(0n),
    failureCode: text('failure_code'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('payments_order_idx').on(t.orderId)],
);

export const paymentEvents = pgTable(
  'payment_events',
  {
    gateway: text('gateway').notNull(),
    eventId: text('event_id').notNull(),
    type: text('type').notNull(),
    payload: jsonb('payload').notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp('processed_at', { withTimezone: true }),
    error: text('error'),
  },
  (t) => [primaryKey({ columns: [t.gateway, t.eventId] })],
);

export const refunds = pgTable(
  'refunds',
  {
    id: id(),
    paymentId: uuid('payment_id')
      .notNull()
      .references(() => payments.id, { onDelete: 'restrict' }),
    amount: minor('amount').notNull(),
    currency: char('currency', { length: 3 }).notNull(),
    status: text('status').notNull().default('pending'),
    gatewayRef: text('gateway_ref'),
    reason: text('reason').notNull().default(''),
    actor: text('actor').notNull(),
    idempotencyKey: text('idempotency_key').notNull().unique('refunds_idempotency_key_key'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('refunds_payment_idx').on(t.paymentId)],
);

export const fxRates = pgTable(
  'fx_rates',
  {
    base: char('base', { length: 3 }).notNull(),
    quote: char('quote', { length: 3 }).notNull(),
    rateNum: minor('rate_num').notNull(),
    rateDen: minor('rate_den').notNull(),
    source: text('source').notNull(),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.base, t.quote, t.fetchedAt] })],
);
