import type { PaymentStatus } from './gateway';

/**
 * Legal payment status moves. The gateway is the source of truth, so the table is deliberately permissive where
 * real gateways are: a late success after a reported failure (a retry with another method) is valid.
 */
export const paymentTransitions: Readonly<Record<PaymentStatus, readonly PaymentStatus[]>> = {
  pending: ['requires_action', 'authorized', 'captured', 'failed', 'voided'],
  requires_action: ['pending', 'authorized', 'captured', 'failed', 'voided'],
  authorized: ['captured', 'voided', 'failed'],
  captured: ['partially_refunded', 'refunded'],
  partially_refunded: ['partially_refunded', 'refunded'],
  failed: ['requires_action', 'authorized', 'captured'],
  voided: [],
  refunded: [],
};

export const canMovePayment = (from: PaymentStatus, to: PaymentStatus): boolean =>
  paymentTransitions[from].includes(to);

/** Statuses in which a shopper can still complete (or be asked to complete) payment. */
export const openPaymentStatuses: readonly PaymentStatus[] = [
  'pending',
  'requires_action',
  'authorized',
];
