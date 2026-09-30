import { z } from 'zod';

export const addressSchema = z.strictObject({
  name: z.string().trim().max(200).optional(),
  line1: z.string().trim().min(1).max(200),
  line2: z.string().trim().max(200).optional(),
  city: z.string().trim().min(1).max(120),
  region: z.string().trim().max(60).default(''),
  postalCode: z.string().trim().min(1).max(20),
  country: z
    .string()
    .trim()
    .length(2)
    .transform((c) => c.toUpperCase()),
});

export const placeOrderInput = z.strictObject({
  cartId: z.uuid(),
  email: z.email().max(254),
  customerId: z.uuid().nullable().default(null),
  shippingAddress: addressSchema,
  /** Defaults to the shipping address. */
  billingAddress: addressSchema.optional(),
  shippingMethodId: z.string().min(1).max(64),
  customerTaxExempt: z.boolean().default(false),
});
export type PlaceOrderInput = z.input<typeof placeOrderInput>;
