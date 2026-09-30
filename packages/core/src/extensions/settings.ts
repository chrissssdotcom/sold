import { z } from 'zod';
import type { ExtensionManifest, SettingsDefinition } from '@sold/extension-sdk';
import { DecryptionError, type EnvelopeCrypto } from '../crypto/envelope';

/** Largest serialised value of one setting. A setting is configuration, not storage: this bounds row size and memory. */
export const MAX_SETTING_BYTES = 64 * 1024;

export interface SettingsRow {
  key: string;
  /** Plaintext JSON for non-secret keys. */
  value: unknown;
  /** Envelope-encrypted JSON for secret keys. Exactly one of `value`/`ciphertext` is set. */
  ciphertext: string | null;
}

export interface SettingsStore {
  load(extension: string): Promise<SettingsRow[]>;
  /** Every encrypted row of every extension (registered or not): the input of key rotation. */
  loadSecrets(): Promise<(SettingsRow & { extension: string })[]>;
  /** Upserts the given rows and deletes `remove` keys, atomically. */
  save(
    extension: string,
    changes: { upsert: SettingsRow[]; remove: string[]; actor: string },
  ): Promise<void>;
}

export interface AuditEntry {
  action: 'extension.settings.updated' | 'extension.settings.rotated';
  actor: string;
  extension: string;
  /** Keys only. Values (especially secrets) are never written to the audit log. */
  changedKeys: string[];
  at: Date;
}

export interface AuditSink {
  record(entry: AuditEntry): Promise<void>;
}

export const noopAudit: AuditSink = { record: async () => undefined };

export class SettingsValidationError extends Error {
  constructor(
    public readonly extension: string,
    public readonly issues: { path: string; message: string }[],
  ) {
    super(
      `Invalid settings for "${extension}": ${issues.map((i) => `${i.path || '(root)'}: ${i.message}`).join('; ')}`,
    );
    this.name = 'SettingsValidationError';
  }
}

export interface FormField {
  key: string;
  type: string;
  title: string;
  description?: string;
  default?: unknown;
  enum?: unknown[];
  format?: string;
  secret: boolean;
  /** For secrets: whether a value is stored (the value itself is never returned). Otherwise the current value. */
  hasValue: boolean;
  value?: unknown;
  /** A stored secret that cannot be decrypted with the configured keys: the admin must enter it again. */
  unreadable?: boolean;
}

export interface SettingsServiceOptions {
  store: SettingsStore;
  crypto: EnvelopeCrypto;
  audit?: AuditSink;
  /** How long an in-memory snapshot is served before reloading. */
  ttlMs?: number;
  now?: () => number;
  /** Reports background refresh problems (never secrets or values). */
  onError?: (extension: string, error: Error) => void;
}

type Snapshot = { values: Readonly<Record<string, unknown>>; expiresAt: number };

export interface SettingsHealth {
  /** Extensions whose settings cannot currently be read (undecryptable secret, invalid store): they run degraded. */
  degraded: { extension: string; reason: string }[];
}

export interface RotationReport {
  rotated: { extension: string; key: string }[];
  /** Rows that could not be re-encrypted (no key can decrypt them). They are left untouched. */
  failed: { extension: string; key: string; reason: string }[];
  /** Rows already under the current key. */
  current: number;
}

export interface RefreshOptions {
  intervalMs?: number;
  /** Fraction of the interval added at random to each tick, so instances do not refresh in lockstep. */
  jitter?: number;
}

/** Freezes a value and everything reachable from it. Settings are shared between callers: nobody may change them. */
export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

const hasOwn = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

/**
 * Typed, validated extension settings. Secrets are envelope-encrypted at rest, decrypted only for the
 * owning extension, and never appear in forms, errors or audit entries.
 *
 * `snapshot()` is synchronous and memory-only for hot paths: it never touches the database.
 *
 * Freshness (documented bound): `set()` refreshes THIS instance's snapshot immediately. Other instances pick the
 * change up on their next background refresh (`startRefresh`, default every 15 s plus up to 20 % jitter, so within
 * ~18 s), and `get()` re-reads on its own when a snapshot is older than `ttlMs` (30 s) even if the refresh loop died.
 *
 * Failure isolation: a setting that cannot be read (a secret no configured key decrypts, a row that no longer fits
 * the schema and has no defaults) degrades THAT extension: `get()` throws for it, the hot-path snapshot falls back
 * to schema defaults, and `health()` reports it. It never takes other extensions or the kernel down.
 */
export class SettingsService {
  private readonly defs = new Map<string, SettingsDefinition>();
  private readonly cache = new Map<string, Snapshot>();
  /** Bumped by every write, so a read that started before the write cannot overwrite the fresher snapshot. */
  private readonly generation = new Map<string, number>();
  private readonly degraded = new Map<string, string>();
  private readonly store: SettingsStore;
  private readonly crypto: EnvelopeCrypto;
  private readonly audit: AuditSink;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly onError: (extension: string, error: Error) => void;
  private timer: NodeJS.Timeout | undefined;
  private refreshing = false;

  constructor(opts: SettingsServiceOptions) {
    this.store = opts.store;
    this.crypto = opts.crypto;
    this.audit = opts.audit ?? noopAudit;
    this.ttlMs = opts.ttlMs ?? 30_000;
    this.now = opts.now ?? Date.now;
    this.onError = opts.onError ?? (() => undefined);
  }

  register(manifest: ExtensionManifest): void {
    if (manifest.settings) this.defs.set(manifest.name, manifest.settings);
  }

  has(extension: string): boolean {
    return this.defs.has(extension);
  }

  private def(extension: string): SettingsDefinition {
    const def = this.defs.get(extension);
    if (!def) throw new Error(`Extension "${extension}" declares no settings`);
    return def;
  }

  private context(extension: string, key: string): string {
    return `ext:${extension}:${key}`;
  }

  private gen(extension: string): number {
    return this.generation.get(extension) ?? 0;
  }

  /**
   * Load and validate. `tolerant` (used by writers and the admin form) treats a secret that cannot be decrypted as
   * absent and lists it in `unreadable`, so an admin can always overwrite a broken secret.
   */
  private async read(
    extension: string,
    tolerant = false,
  ): Promise<{ values: Record<string, unknown>; unreadable: string[] }> {
    const def = this.def(extension);
    const secrets = new Set<string>(def.secrets ?? []);
    const raw: Record<string, unknown> = {};
    const unreadable: string[] = [];
    for (const row of await this.store.load(extension)) {
      if (row.ciphertext !== null) {
        if (!secrets.has(row.key)) continue; // a stale secret for a field that is no longer secret
        try {
          raw[row.key] = JSON.parse(
            this.crypto.decrypt(row.ciphertext, this.context(extension, row.key)),
          );
        } catch (error) {
          if (!tolerant || !(error instanceof DecryptionError)) throw error;
          unreadable.push(row.key);
        }
      } else if (!secrets.has(row.key)) {
        raw[row.key] = row.value;
      }
    }
    const parsed = def.schema.safeParse(raw);
    if (!parsed.success) {
      // Stored data no longer matches the schema (e.g. after an extension upgrade): fall back to defaults for a clean read.
      const fallback = def.schema.safeParse({});
      if (fallback.success) return { values: fallback.data, unreadable };
      throw new SettingsValidationError(extension, issuesOf(parsed.error));
    }
    return { values: parsed.data, unreadable };
  }

  private markDegraded(extension: string, error: unknown): void {
    const reason =
      error instanceof DecryptionError
        ? 'a stored secret cannot be decrypted with the configured SOLD_SECRET_KEY / SOLD_SECRET_KEY_PREVIOUS'
        : error instanceof SettingsValidationError
          ? 'stored settings do not validate and the schema has no defaults'
          : `settings could not be read: ${error instanceof Error ? error.message : String(error)}`;
    this.degraded.set(extension, reason);
    this.onError(extension, error instanceof Error ? error : new Error(String(error)));
  }

  /** Load into the cache unless a write happened meanwhile. Throws on failure. */
  private async load(extension: string): Promise<Readonly<Record<string, unknown>>> {
    const g = this.gen(extension);
    const { values } = await this.read(extension);
    const frozen = deepFreeze(values);
    this.degraded.delete(extension);
    if (this.gen(extension) === g)
      this.cache.set(extension, { values: frozen, expiresAt: this.now() + this.ttlMs });
    return frozen;
  }

  /**
   * Current settings with defaults applied and secrets decrypted. The returned object is deeply frozen and shared:
   * copy it if you need to change it.
   */
  async get(extension: string): Promise<Readonly<Record<string, unknown>>> {
    const cached = this.cache.get(extension);
    if (cached && cached.expiresAt > this.now()) return cached.values;
    try {
      return await this.load(extension);
    } catch (error) {
      this.markDegraded(extension, error);
      // Stale-if-error: a value that was good a moment ago beats an outage of the extension.
      if (cached) return cached.values;
      throw error;
    }
  }

  /** Memory-only view for hot paths. `undefined` until `get`/`warm` has loaded it. */
  snapshot(extension: string): Readonly<Record<string, unknown>> | undefined {
    return this.cache.get(extension)?.values;
  }

  /** Settings as a fresh install would parse them (schema defaults). Memory-only; used until a snapshot is warm. */
  defaults(extension: string): Readonly<Record<string, unknown>> {
    const parsed = this.def(extension).schema.safeParse({});
    return deepFreeze(parsed.success ? parsed.data : {});
  }

  /**
   * Load every registered extension's settings into memory (call at boot). One extension failing does not stop the
   * others: it is recorded as degraded (see `health()`).
   */
  async warm(): Promise<SettingsHealth> {
    await Promise.all(
      [...this.defs.keys()].map((e) =>
        this.get(e).catch(() => undefined /* recorded by get() as degraded */),
      ),
    );
    return this.health();
  }

  health(): SettingsHealth {
    return {
      degraded: [...this.degraded.entries()].map(([extension, reason]) => ({ extension, reason })),
    };
  }

  /**
   * Keep the hot-path snapshots fresh. The timer is unref'd (never keeps the process alive), jittered, and a failed
   * refresh keeps the last good snapshot. Returns a stop function; calling it twice is harmless.
   */
  startRefresh(opts: RefreshOptions = {}): () => void {
    this.stopRefresh();
    const interval = opts.intervalMs ?? 15_000;
    const jitter = opts.jitter ?? 0.2;
    const tick = () => {
      this.timer = setTimeout(
        () => {
          void this.refreshAll().finally(() => {
            if (this.timer) tick();
          });
        },
        interval + Math.random() * interval * jitter,
      );
      this.timer.unref();
    };
    tick();
    return () => this.stopRefresh();
  }

  stopRefresh(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** One refresh pass over every registered extension. Failures degrade only that extension. */
  async refreshAll(): Promise<void> {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      await Promise.all(
        [...this.defs.keys()].map(async (e) => {
          try {
            await this.load(e);
          } catch (error) {
            this.markDegraded(e, error);
          }
        }),
      );
    } finally {
      this.refreshing = false;
    }
  }

  /**
   * Re-encrypt every stored secret (of every extension, registered or not) under the CURRENT root key. Run after
   * changing `SOLD_SECRET_KEY` with the old key listed in `SOLD_SECRET_KEY_PREVIOUS`; once nothing is left to rotate
   * the previous key can be removed. Rows no key can decrypt are reported and left untouched.
   */
  async rotate(actor: string): Promise<RotationReport> {
    const report: RotationReport = { rotated: [], failed: [], current: 0 };
    const byExtension = new Map<string, SettingsRow[]>();
    for (const row of await this.store.loadSecrets()) {
      if (row.ciphertext === null) continue;
      if (!this.crypto.needsRotation(row.ciphertext)) {
        report.current++;
        continue;
      }
      const context = this.context(row.extension, row.key);
      try {
        const ciphertext = this.crypto.rewrap(row.ciphertext, context);
        byExtension.set(row.extension, [
          ...(byExtension.get(row.extension) ?? []),
          { key: row.key, value: null, ciphertext },
        ]);
        report.rotated.push({ extension: row.extension, key: row.key });
      } catch (error) {
        report.failed.push({
          extension: row.extension,
          key: row.key,
          reason: error instanceof DecryptionError ? error.message : String(error),
        });
      }
    }
    for (const [extension, upsert] of byExtension) {
      await this.store.save(extension, { upsert, remove: [], actor });
      this.generation.set(extension, this.gen(extension) + 1);
      await this.audit.record({
        action: 'extension.settings.rotated',
        actor,
        extension,
        changedKeys: upsert.map((r) => r.key).sort(),
        at: new Date(this.now()),
      });
    }
    return report;
  }

  /**
   * Patch settings. Absent keys are unchanged; for a secret, `null` clears it. The merged result is
   * validated before anything is written, so a bad patch leaves the store untouched.
   */
  async set(
    extension: string,
    patch: Record<string, unknown>,
    actor: string,
  ): Promise<{ changedKeys: string[] }> {
    const def = this.def(extension);
    const secrets = new Set<string>(def.secrets ?? []);
    const shape = def.schema.shape as Record<string, unknown>;
    // Own keys only: `constructor`, `__proto__` and `toString` are "in" every object.
    const unknownKeys = Object.keys(patch).filter((k) => !hasOwn(shape, k));
    if (unknownKeys.length > 0) {
      throw new SettingsValidationError(
        extension,
        unknownKeys.map((k) => ({ path: k, message: 'unknown setting' })),
      );
    }
    const oversized = Object.entries(patch).filter(
      ([, v]) => v !== undefined && Buffer.byteLength(JSON.stringify(v) ?? '') > MAX_SETTING_BYTES,
    );
    if (oversized.length > 0) {
      throw new SettingsValidationError(
        extension,
        oversized.map(([k]) => ({
          path: k,
          message: `value is larger than ${MAX_SETTING_BYTES / 1024} KiB (settings are configuration, not storage)`,
        })),
      );
    }

    // Tolerant: an admin must be able to overwrite a secret that can no longer be decrypted.
    const { values: current } = await this.read(extension, true);
    const merged: Record<string, unknown> = { ...current };
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue;
      if (v === null && secrets.has(k)) delete merged[k];
      else merged[k] = v;
    }
    const parsed = def.schema.safeParse(merged);
    if (!parsed.success) throw new SettingsValidationError(extension, issuesOf(parsed.error));

    const upsert: SettingsRow[] = [];
    const remove: string[] = [];
    const changedKeys: string[] = [];
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue;
      changedKeys.push(k);
      if (secrets.has(k)) {
        if (v === null) remove.push(k);
        else
          upsert.push({
            key: k,
            value: null,
            ciphertext: this.crypto.encrypt(
              JSON.stringify(parsed.data[k]),
              this.context(extension, k),
            ),
          });
      } else if (parsed.data[k] === undefined || parsed.data[k] === null) {
        // An unset optional field has no row: `value` and `ciphertext` cannot both be NULL.
        remove.push(k);
      } else {
        upsert.push({ key: k, value: parsed.data[k], ciphertext: null });
      }
    }
    changedKeys.sort(); // stable, reviewable audit entries
    if (changedKeys.length === 0) return { changedKeys };
    await this.store.save(extension, { upsert, remove, actor });
    // Refresh (not delete) the local snapshot: hot-path interceptors must never fall back to schema defaults.
    // Re-reading what was just written keeps this instance identical to what every other instance will load.
    this.generation.set(extension, this.gen(extension) + 1);
    await this.load(extension).catch((error: unknown) => {
      this.cache.delete(extension);
      this.markDegraded(extension, error);
    });
    await this.audit.record({
      action: 'extension.settings.updated',
      actor,
      extension,
      changedKeys,
      at: new Date(this.now()),
    });
    return { changedKeys };
  }

  /**
   * Describes the settings form for the admin UI (rendered automatically). Secret values are never
   * returned: only whether one is stored.
   */
  async describeForm(extension: string): Promise<FormField[]> {
    const def = this.def(extension);
    const secrets = new Set<string>(def.secrets ?? []);
    const json = z.toJSONSchema(def.schema, { io: 'input', unrepresentable: 'any' }) as {
      properties?: Record<string, Record<string, unknown>>;
    };
    const stored = new Set((await this.store.load(extension)).map((r) => r.key));
    // Tolerant: the form must still open when a stored secret cannot be decrypted, so it can be entered again.
    const { values, unreadable } = await this.read(extension, true);
    return Object.entries(json.properties ?? {}).map(([key, prop]) => {
      const secret = secrets.has(key);
      const field: FormField = {
        key,
        type: Array.isArray(prop.type) ? String(prop.type[0]) : String(prop.type ?? 'string'),
        title: typeof prop.title === 'string' ? prop.title : humanise(key),
        secret,
        hasValue: secret ? stored.has(key) : values[key] !== undefined,
      };
      if (typeof prop.description === 'string') field.description = prop.description;
      if (prop.default !== undefined && !secret) field.default = prop.default;
      if (Array.isArray(prop.enum)) field.enum = prop.enum;
      if (typeof prop.format === 'string') field.format = prop.format;
      if (!secret) field.value = values[key];
      if (unreadable.includes(key)) field.unreadable = true;
      return field;
    });
  }
}

function issuesOf(error: z.ZodError): { path: string; message: string }[] {
  return error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
}

function humanise(key: string): string {
  const spaced = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replaceAll(/[_-]/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
