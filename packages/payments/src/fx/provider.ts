import { parseDecimalRational, type Rational } from '@sold/core';

export interface FxQuote {
  base: string;
  quote: string;
  rate: Rational;
}

/**
 * Source of exchange rates. Rates are exact rationals: a provider that speaks JSON numbers converts them from the
 * shortest decimal representation, never through binary floating-point arithmetic.
 */
export interface FxProvider {
  readonly name: string;
  fetchRates(base: string, quotes: readonly string[]): Promise<FxQuote[]>;
}

/** Fixed rates: tests, air-gapped installs, and pinned rates for a campaign. */
export class StaticFxProvider implements FxProvider {
  readonly name = 'static';
  constructor(private readonly rates: Record<string, string>) {}
  async fetchRates(base: string, quotes: readonly string[]): Promise<FxQuote[]> {
    return quotes.flatMap((q) => {
      const r = this.rates[`${base}${q}`];
      return r ? [{ base, quote: q, rate: parseDecimalRational(r) }] : [];
    });
  }
}

/** Convert a JSON number or string to an exact rational, including exponent notation (`1e-7`). */
export function rationalFromJson(value: unknown): Rational {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0)
      throw new RangeError('Rate must be a positive finite number');
    return parseDecimalRational(expandExponent(String(value)));
  }
  if (typeof value === 'string') return parseDecimalRational(expandExponent(value.trim()));
  throw new RangeError('Rate must be a number or decimal string');
}

function expandExponent(text: string): string {
  const m = /^(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/.exec(text);
  if (!m) return text;
  const whole = m[1] as string;
  const frac = m[2] ?? '';
  const exp = Number(m[3]);
  const digits = whole + frac;
  const point = whole.length + exp;
  if (point <= 0) return `0.${'0'.repeat(-point)}${digits}`;
  if (point >= digits.length) return digits + '0'.repeat(point - digits.length);
  return `${digits.slice(0, point)}.${digits.slice(point)}`;
}

export interface HttpFxProviderOptions {
  /** Builds the request URL. Default targets a Frankfurter-style API: `<baseUrl>/latest?from=AUD&to=USD,JPY`. */
  url: (base: string, quotes: readonly string[]) => string;
  name?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  headers?: Record<string, string>;
}

/**
 * Generic JSON rate feed: expects `{ "rates": { "USD": 0.65, ... } }`, the shape used by common free feeds
 * (Frankfurter/ECB, open.er-api.com). The exact endpoint is configuration, NOT verified from this environment:
 * point `url` at the feed you contract with and confirm the response shape in staging first.
 */
export class HttpFxProvider implements FxProvider {
  readonly name: string;
  constructor(private readonly opts: HttpFxProviderOptions) {
    this.name = opts.name ?? 'http';
  }

  async fetchRates(base: string, quotes: readonly string[]): Promise<FxQuote[]> {
    const res = await (this.opts.fetch ?? fetch)(this.opts.url(base, quotes), {
      headers: { accept: 'application/json', ...(this.opts.headers ?? {}) },
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 10_000),
    });
    if (!res.ok) throw new Error(`FX feed returned ${res.status}`);
    const body = (await res.json()) as { rates?: Record<string, unknown> };
    if (!body.rates || typeof body.rates !== 'object')
      throw new Error('FX feed response has no "rates"');
    return quotes.flatMap((q) => {
      const raw = body.rates?.[q];
      return raw === undefined ? [] : [{ base, quote: q, rate: rationalFromJson(raw) }];
    });
  }
}
