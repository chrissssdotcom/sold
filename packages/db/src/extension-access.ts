/**
 * The database privileges an extension may ever have, in ONE place. Everything else (the runtime roles, the
 * migration linter, the docs in `docs/extending.md`) derives from these constants, so they cannot drift.
 *
 * Trust model (ADR-0004): extensions are trusted, reviewed, in-process code. There is no sandbox. What this
 * module defines is the database privilege boundary that `ctx.db` runs under, plus what the migration linter
 * lets an extension's SQL touch.
 */

/**
 * Base tables an extension may READ (`SELECT` only, never write). This is a deliberate, small contract: adding a
 * table here widens what every installed extension can see, so it needs a review and a docs update.
 * Nothing that holds secrets, credentials, personal data beyond orders/carts, job payloads or platform state is on it.
 */
export const BASE_READ_TABLES = [
  'products',
  'product_variants',
  'variant_prices',
  'orders',
  'order_lines',
  'order_status_history',
  'carts',
  'cart_lines',
] as const;

/**
 * Base tables an extension's own table may reference with a foreign key (used by the migration linter only).
 * A foreign key never grants read access at runtime: the referential check runs as the table owner.
 */
export const BASE_REFERENCEABLE_TABLES: readonly string[] = [...BASE_READ_TABLES, 'customers'];

/** Base trigger functions an extension's trigger may execute (extension migrations cannot create plpgsql functions). */
export const BASE_TRIGGER_FUNCTIONS = ['sold_touch_updated_at'] as const;

/**
 * Base functions that take a `regclass` first argument and act on that table. An extension migration may call them
 * only with a literal naming ITS OWN table (partitioning its own high-volume table, ADR-0001).
 */
export const BASE_TABLE_FUNCTIONS = [
  'sold_ensure_monthly_partitions',
  'sold_drop_old_partitions',
] as const;

/** Tables that must never be readable or writable by any extension role. Documented and asserted in tests. */
export const BASE_FORBIDDEN_TABLES = [
  'extension_settings',
  'extension_registry',
  '_sold_migrations',
  'feature_flags',
  'outbox_events',
  'idempotency_keys',
] as const;

/** Extension name (kebab-case) to the snake_case token used in table prefixes and role names. */
export const extensionToken = (extension: string): string => extension.replaceAll('-', '_');

/** `ext_<name>_`: the namespace an extension owns in the `public` schema. */
export function extensionPrefix(extension: string): string {
  return `ext_${extensionToken(extension)}_`;
}

/**
 * True when `name` is an object name in the extension's namespace: the exact prefix followed by at least one
 * character from `[a-z0-9_]` (so quoted identifiers with quotes, semicolons, spaces or capitals are never "owned").
 * `otherExtensions` are the other known extensions: a name that falls in the namespace of one of THEM whose prefix is
 * longer (`foo` vs `foo-bar`: `ext_foo_bar_accounts`) is not ours.
 */
export function ownsObject(
  extension: string,
  name: string,
  otherExtensions: readonly string[] = [],
): boolean {
  const prefix = extensionPrefix(extension);
  if (!new RegExp(`^${prefix}[a-z0-9_]+$`).test(name)) return false;
  for (const other of otherExtensions) {
    if (other === extension) continue;
    const otherPrefix = extensionPrefix(other);
    if (otherPrefix.length > prefix.length && name.startsWith(otherPrefix)) return false;
  }
  return true;
}

/**
 * Extension names whose table prefixes collide (one is a prefix of another, e.g. `foo` and `foo-bar`). Their
 * objects would be indistinguishable by name, so such a set of extensions cannot be installed together.
 */
export function prefixCollisions(names: readonly string[]): [string, string][] {
  const out: [string, string][] = [];
  const sorted = [...new Set(names)].sort();
  for (const a of sorted)
    for (const b of sorted)
      if (a !== b && extensionPrefix(b).startsWith(extensionPrefix(a))) out.push([a, b]);
  return out;
}
