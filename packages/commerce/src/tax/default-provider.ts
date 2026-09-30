import { createTaxProvider } from './provider';
import { defaultTaxTable } from './tables';
import type { TaxProvider } from './types';

/** Table-driven provider over the illustrative bundled tables (`tables.ts`): not legal or tax advice. */
export const defaultTaxProvider: TaxProvider = createTaxProvider(defaultTaxTable);
