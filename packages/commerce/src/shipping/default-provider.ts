import { createShippingProvider } from './provider';
import { exampleShippingConfig } from './defaults';
import type { ShippingProvider } from './types';

/** Provider over the illustrative example config (`defaults.ts`); real stores supply their own config. */
export const defaultShippingProvider: ShippingProvider =
  createShippingProvider(exampleShippingConfig);
