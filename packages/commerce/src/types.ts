import type { PrimaryDb } from '@sold/db';

/** A Drizzle transaction on the primary. Domain writes that must be atomic take one of these. */
export type Tx = Parameters<Parameters<PrimaryDb['transaction']>[0]>[0];
export type DbOrTx = PrimaryDb | Tx;
