import { ConflictError } from '../errors';

export const orderStatuses = [
  'pending_payment',
  'paid',
  'processing',
  'shipped',
  'delivered',
  'cancelled',
  'refunded',
] as const;
export type OrderStatus = (typeof orderStatuses)[number];

/**
 * The only legal order transitions. Anything else is a bug or a race and is refused, so an order can never
 * jump from `cancelled` back to `shipped` because two workers disagreed.
 *
 *   pending_payment -> paid | cancelled
 *   paid            -> processing | cancelled | refunded
 *   processing      -> shipped | cancelled | refunded
 *   shipped         -> delivered | refunded
 *   delivered       -> refunded
 *   cancelled, refunded: terminal
 */
export const transitions: Readonly<Record<OrderStatus, readonly OrderStatus[]>> = {
  pending_payment: ['paid', 'cancelled'],
  paid: ['processing', 'cancelled', 'refunded'],
  processing: ['shipped', 'cancelled', 'refunded'],
  shipped: ['delivered', 'refunded'],
  delivered: ['refunded'],
  cancelled: [],
  refunded: [],
};

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return transitions[from].includes(to);
}

export function isTerminal(status: OrderStatus): boolean {
  return transitions[status].length === 0;
}

export function assertTransition(from: OrderStatus, to: OrderStatus): void {
  if (!canTransition(from, to)) {
    throw new ConflictError('illegal_transition', `Order cannot move from ${from} to ${to}`, {
      from,
      to,
    });
  }
}

/** Whether the shopper (not staff) may cancel on their own. */
export function shopperCanCancel(status: OrderStatus): boolean {
  return status === 'pending_payment' || status === 'paid';
}

/** Statuses in which stock is still only *held* (not yet permanently decremented). */
export function holdsReservation(status: OrderStatus): boolean {
  return status === 'pending_payment';
}
