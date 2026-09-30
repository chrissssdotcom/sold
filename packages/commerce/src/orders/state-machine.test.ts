import { describe, expect, it } from 'vitest';
import {
  assertTransition,
  canTransition,
  holdsReservation,
  isTerminal,
  orderStatuses,
  shopperCanCancel,
  transitions,
} from './state-machine';

describe('order state machine', () => {
  it('allows exactly the documented transitions (exhaustive matrix)', () => {
    const allowed = new Set([
      'pending_payment>paid',
      'pending_payment>cancelled',
      'paid>processing',
      'paid>cancelled',
      'paid>refunded',
      'processing>shipped',
      'processing>cancelled',
      'processing>refunded',
      'shipped>delivered',
      'shipped>refunded',
      'delivered>refunded',
    ]);
    for (const from of orderStatuses)
      for (const to of orderStatuses)
        expect(canTransition(from, to), `${from} -> ${to}`).toBe(allowed.has(`${from}>${to}`));
  });

  it('has no self-transitions and terminal states have no exits', () => {
    for (const s of orderStatuses) expect(canTransition(s, s)).toBe(false);
    expect(isTerminal('cancelled')).toBe(true);
    expect(isTerminal('refunded')).toBe(true);
    expect(isTerminal('paid')).toBe(false);
  });

  it('every state is reachable from pending_payment', () => {
    const seen = new Set<string>(['pending_payment']);
    const queue = ['pending_payment'] as (typeof orderStatuses)[number][];
    while (queue.length) {
      const s = queue.shift()!;
      for (const n of transitions[s])
        if (!seen.has(n)) {
          seen.add(n);
          queue.push(n);
        }
    }
    expect([...seen].sort()).toEqual([...orderStatuses].sort());
  });

  it('assertTransition throws a stable code', () => {
    expect(() => assertTransition('cancelled', 'shipped')).toThrowError(
      expect.objectContaining({ code: 'illegal_transition', status: 409 }),
    );
    expect(() => assertTransition('paid', 'processing')).not.toThrow();
  });

  it('shopper cancellation and reservation holding', () => {
    expect(shopperCanCancel('pending_payment')).toBe(true);
    expect(shopperCanCancel('shipped')).toBe(false);
    expect(holdsReservation('pending_payment')).toBe(true);
    expect(holdsReservation('paid')).toBe(false);
  });
});
