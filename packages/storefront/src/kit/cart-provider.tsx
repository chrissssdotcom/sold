'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  type ReactNode,
} from 'react';
import type { MoneyJson } from './money';

export interface CartItem {
  variantId: string;
  handle: string;
  title: string;
  sku: string;
  image: string | null;
  quantity: number;
  unitPrice: MoneyJson;
  lineTotal: MoneyJson;
  discount: MoneyJson;
}

interface Estimate {
  currency: string;
  discounts: { name: string; code: string | null; amount: MoneyJson }[];
  rejectedCoupons: { code: string; reason: string }[];
  subtotal: MoneyJson;
  discountTotal: MoneyJson;
  net: MoneyJson;
  freeShipping: boolean;
}

interface State {
  loaded: boolean;
  open: boolean;
  busy: boolean;
  error: string | null;
  notice: string | null;
  version: number;
  couponCodes: string[];
  items: CartItem[];
  estimate: Estimate | null;
}

type Action =
  | { type: 'open'; open: boolean }
  | { type: 'busy'; busy: boolean }
  | { type: 'error'; message: string | null }
  | { type: 'notice'; message: string | null }
  | { type: 'loaded'; payload: Partial<Omit<State, 'open' | 'busy' | 'error' | 'notice'>> };

const initial: State = {
  loaded: false,
  open: false,
  busy: false,
  error: null,
  notice: null,
  version: 0,
  couponCodes: [],
  items: [],
  estimate: null,
};

function reducer(s: State, a: Action): State {
  switch (a.type) {
    case 'open':
      return { ...s, open: a.open };
    case 'busy':
      return { ...s, busy: a.busy };
    case 'error':
      return { ...s, error: a.message };
    case 'notice':
      return { ...s, notice: a.message };
    case 'loaded':
      return { ...s, ...a.payload, loaded: true, error: null };
  }
}

interface CartApi extends State {
  count: number;
  add(variantId: string, quantity: number, label?: string): Promise<boolean>;
  setQuantity(variantId: string, quantity: number): Promise<void>;
  applyCoupon(code: string): Promise<boolean>;
  removeCoupon(code: string): Promise<void>;
  refresh(): Promise<void>;
  openCart(): void;
  closeCart(): void;
}

const Ctx = createContext<CartApi | null>(null);

export function useCart(): CartApi {
  const c = useContext(Ctx);
  if (!c) throw new Error('useCart must be used inside <CartProvider>');
  return c;
}

const ERRORS: Record<string, string> = {
  insufficient_stock: 'Sorry, there is not enough stock for that quantity.',
  cart_version_conflict: 'Your bag changed in another tab. We refreshed it.',
  validation_failed: 'That could not be added.',
  not_found: 'That item is no longer available.',
};

interface CartBody {
  cart?: { version: number; couponCodes: string[]; currency: string } | null;
  items?: CartItem[];
  estimate?: Estimate | null;
  error?: { code?: string; message?: string };
}
interface CallResult {
  ok: boolean;
  status: number;
  body: CartBody | null;
}

async function call(path: string, init?: RequestInit): Promise<CallResult> {
  const res = await fetch(path, {
    ...init,
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  let body: CartBody | null = null;
  try {
    body = (await res.json()) as CartBody;
  } catch {
    /* empty */
  }
  return { ok: res.ok, status: res.status, body };
}

export function CartProvider({ currency, children }: { currency: string; children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initial);
  const currencyRef = useRef(currency);
  currencyRef.current = currency;

  const apply = useCallback((body: CartBody | null) => {
    dispatch({
      type: 'loaded',
      payload: {
        version: body?.cart?.version ?? 0,
        couponCodes: body?.cart?.couponCodes ?? [],
        items: body?.items ?? [],
        estimate: body?.estimate ?? null,
      },
    });
  }, []);

  const refresh = useCallback(async () => {
    const r = await call('/api/cart');
    if (r.ok && r.body?.cart) {
      const body = r.body;
      // A cart in another market's currency is not shown: the shopper is in a different storefront now.
      if (body.cart && body.cart.currency !== currencyRef.current)
        return dispatch({
          type: 'loaded',
          payload: { items: [], estimate: null, version: 0, couponCodes: [] },
        });
      apply(body);
    } else
      dispatch({
        type: 'loaded',
        payload: { items: [], estimate: null, version: 0, couponCodes: [] },
      });
  }, [apply]);

  useEffect(() => {
    void refresh();
  }, [refresh, currency]);

  const mutate = useCallback(
    async (fn: () => Promise<CallResult>): Promise<boolean> => {
      dispatch({ type: 'busy', busy: true });
      try {
        const r = await fn();
        if (!r.ok) {
          const code = r.body?.error?.code ?? 'error';
          dispatch({
            type: 'error',
            message:
              ERRORS[code] ?? r.body?.error?.message ?? 'Something went wrong. Please try again.',
          });
          if (code === 'cart_version_conflict') await refresh();
          return false;
        }
        await refresh();
        return true;
      } catch {
        dispatch({ type: 'error', message: 'Network problem. Please try again.' });
        return false;
      } finally {
        dispatch({ type: 'busy', busy: false });
      }
    },
    [refresh],
  );

  const api = useMemo<CartApi>(
    () => ({
      ...state,
      count: state.items.reduce((n, i) => n + i.quantity, 0),
      refresh,
      openCart: () => dispatch({ type: 'open', open: true }),
      closeCart: () => dispatch({ type: 'open', open: false }),
      add: async (variantId, quantity, label) => {
        const ok = await mutate(async () => {
          const created = await call('/api/cart', {
            method: 'POST',
            body: JSON.stringify({ currency: currencyRef.current }),
          });
          if (!created.ok) return created;
          return call('/api/cart/items', {
            method: 'POST',
            body: JSON.stringify({ variantId, quantity }),
          });
        });
        if (ok) {
          dispatch({
            type: 'notice',
            message: label ? `${label} added to your bag` : 'Added to your bag',
          });
          dispatch({ type: 'open', open: true });
        }
        return ok;
      },
      setQuantity: async (variantId, quantity) => {
        await mutate(() =>
          call(`/api/cart/items/${variantId}`, {
            method: 'PATCH',
            body: JSON.stringify({ quantity, expectedVersion: state.version || undefined }),
          }),
        );
      },
      applyCoupon: (code) =>
        mutate(() => call('/api/cart/coupons', { method: 'POST', body: JSON.stringify({ code }) })),
      removeCoupon: async (code) => {
        await mutate(() =>
          call(`/api/cart/coupons/${encodeURIComponent(code)}`, { method: 'DELETE' }),
        );
      },
    }),
    [state, mutate, refresh],
  );

  return <Ctx.Provider value={api}>{children}</Ctx.Provider>;
}
