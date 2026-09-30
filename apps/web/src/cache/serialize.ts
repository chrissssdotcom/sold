/**
 * JSON serialisation for Next cache entries, which contain Buffers (RSC payloads, images) and
 * Maps (segment data). Buffers are base64 encoded rather than expanded to number arrays.
 */
type Tagged = { __sold: 'buf'; b64: string } | { __sold: 'map'; entries: [unknown, unknown][] };

export function serialize(value: unknown): string {
  return JSON.stringify(value, function (this: Record<string, unknown>, key: string, v: unknown) {
    const original = this[key];
    if (Buffer.isBuffer(original))
      return { __sold: 'buf', b64: original.toString('base64') } satisfies Tagged;
    if (original instanceof Uint8Array) {
      return { __sold: 'buf', b64: Buffer.from(original).toString('base64') } satisfies Tagged;
    }
    if (original instanceof Map)
      return { __sold: 'map', entries: [...original.entries()] } satisfies Tagged;
    return v;
  });
}

export function deserialize<T = unknown>(raw: string): T {
  return JSON.parse(raw, (_key, v: unknown) => {
    if (v && typeof v === 'object' && '__sold' in v) {
      const t = v as Tagged;
      if (t.__sold === 'buf') return Buffer.from(t.b64, 'base64');
      if (t.__sold === 'map') return new Map(t.entries);
    }
    return v;
  }) as T;
}
