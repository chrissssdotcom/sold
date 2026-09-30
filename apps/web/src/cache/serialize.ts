/**
 * JSON serialisation for Next cache entries, which contain Buffers (RSC payloads, images), Maps (segment data)
 * and BigInts. Buffers are base64 encoded rather than expanded to number arrays.
 *
 * Encoded values are tagged objects `{ "$sold": "<kind>", ... }`. A user object that itself has a key named
 * `$sold` (or `$$sold`, ...) is wrapped in an `esc` envelope with those keys shifted right by one `$`, so plain
 * data can never be mistaken for a tag. `JSON.parse` revives children before parents, which is why the keys
 * are renamed rather than the object merely being wrapped.
 */
type Tagged =
  | { $sold: 'buf'; b64: string }
  | { $sold: 'map'; entries: [unknown, unknown][] }
  | { $sold: 'big'; v: string }
  | { $sold: 'esc'; v: Record<string, unknown> };

const RESERVED = /^\$+sold$/;

export function serialize(value: unknown): string {
  // Objects we have already wrapped: the replacer is called again for the wrapper's contents.
  const escaped = new WeakSet<object>();
  return JSON.stringify(value, function (this: Record<string, unknown>, key: string, v: unknown) {
    const original = this[key];
    if (Buffer.isBuffer(original))
      return { $sold: 'buf', b64: original.toString('base64') } satisfies Tagged;
    if (original instanceof Uint8Array)
      return { $sold: 'buf', b64: Buffer.from(original).toString('base64') } satisfies Tagged;
    if (original instanceof Map)
      return { $sold: 'map', entries: [...original.entries()] } satisfies Tagged;
    if (typeof original === 'bigint')
      return { $sold: 'big', v: original.toString() } satisfies Tagged;
    if (
      v &&
      typeof v === 'object' &&
      !Array.isArray(v) &&
      !escaped.has(v) &&
      Object.keys(v).some((k) => RESERVED.test(k))
    ) {
      const inner = Object.fromEntries(
        Object.entries(v).map(([k, val]) => [RESERVED.test(k) ? `$${k}` : k, val]),
      );
      escaped.add(inner);
      return { $sold: 'esc', v: inner } satisfies Tagged;
    }
    return v;
  });
}

export function deserialize<T = unknown>(raw: string): T {
  return JSON.parse(raw, (_key, v: unknown) => {
    if (v && typeof v === 'object' && '$sold' in v) {
      const t = v as Tagged;
      if (t.$sold === 'buf') return Buffer.from(t.b64, 'base64');
      if (t.$sold === 'map') return new Map(t.entries);
      if (t.$sold === 'big') return BigInt(t.v);
      if (t.$sold === 'esc')
        return Object.fromEntries(
          Object.entries(t.v).map(([k, val]) => [/^\$\$+sold$/.test(k) ? k.slice(1) : k, val]),
        );
    }
    return v;
  }) as T;
}
