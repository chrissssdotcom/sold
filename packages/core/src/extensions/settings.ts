import { z } from 'zod';
import type { ExtensionManifest, SettingsDefinition } from '@sold/extension-sdk';
import type { EnvelopeCrypto } from '../crypto/envelope';

export interface SettingsRow {
  key: string;
  /** Plaintext JSON for non-secret keys. */
  value: unknown;
  /** Envelope-encrypted JSON for secret keys. Exactly one of `value`/`ciphertext` is set. */
  ciphertext: string | null;
}

export interface SettingsStore {
  load(extension: string): Promise<SettingsRow[]>;
  /** Upserts the given rows and deletes `remove` keys, atomically. */
  save(
    extension: string,
    changes: { upsert: SettingsRow[]; remove: string[]; actor: string },
  ): Promise<void>;
}

export interface AuditEntry {
  action: 'extension.settings.updated';
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
}

export interface SettingsServiceOptions {
  store: SettingsStore;
  crypto: EnvelopeCrypto;
  audit?: AuditSink;
  /** How long an in-memory snapshot is served before reloading. */
  ttlMs?: number;
  now?: () => number;
}

type Snapshot = { values: Record<string, unknown>; expiresAt: number };

/**
 * Typed, validated extension settings. Secrets are envelope-encrypted at rest, decrypted only for the
 * owning extension, and never appear in forms, errors or audit entries.
 *
 * `snapshot()` is synchronous and memory-only for hot paths: it never touches the database.
 */
export class SettingsService {
  private readonly defs = new Map<string, SettingsDefinition>();
  private readonly cache = new Map<string, Snapshot>();
  private readonly store: SettingsStore;
  private readonly crypto: EnvelopeCrypto;
  private readonly audit: AuditSink;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(opts: SettingsServiceOptions) {
    this.store = opts.store;
    this.crypto = opts.crypto;
    this.audit = opts.audit ?? noopAudit;
    this.ttlMs = opts.ttlMs ?? 30_000;
    this.now = opts.now ?? Date.now;
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

  private async read(extension: string): Promise<Record<string, unknown>> {
    const def = this.def(extension);
    const secrets = new Set<string>(def.secrets ?? []);
    const raw: Record<string, unknown> = {};
    for (const row of await this.store.load(extension)) {
      if (row.ciphertext !== null) {
        if (!secrets.has(row.key)) continue; // a stale secret for a field that is no longer secret
        raw[row.key] = JSON.parse(
          this.crypto.decrypt(row.ciphertext, this.context(extension, row.key)),
        );
      } else if (!secrets.has(row.key)) {
        raw[row.key] = row.value;
      }
    }
    const parsed = def.schema.safeParse(raw);
    if (!parsed.success) {
      // Stored data no longer matches the schema (e.g. after an extension upgrade): fall back to defaults for a clean read.
      const fallback = def.schema.safeParse({});
      if (fallback.success) return fallback.data;
      throw new SettingsValidationError(extension, issuesOf(parsed.error));
    }
    return parsed.data;
  }

  /** Current settings with defaults applied and secrets decrypted. */
  async get(extension: string): Promise<Record<string, unknown>> {
    const cached = this.cache.get(extension);
    if (cached && cached.expiresAt > this.now()) return cached.values;
    const values = await this.read(extension);
    this.cache.set(extension, { values, expiresAt: this.now() + this.ttlMs });
    return values;
  }

  /** Memory-only view for hot paths. `undefined` until `get`/`warm` has loaded it. */
  snapshot(extension: string): Record<string, unknown> | undefined {
    return this.cache.get(extension)?.values;
  }

  /** Settings as a fresh install would parse them (schema defaults). Memory-only; used until a snapshot is warm. */
  defaults(extension: string): Record<string, unknown> {
    const parsed = this.def(extension).schema.safeParse({});
    return parsed.success ? parsed.data : {};
  }

  /** Load every registered extension's settings into memory (call at boot and on a timer). */
  async warm(): Promise<void> {
    await Promise.all([...this.defs.keys()].map((e) => this.get(e)));
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
    const unknownKeys = Object.keys(patch).filter((k) => !(k in shape));
    if (unknownKeys.length > 0) {
      throw new SettingsValidationError(
        extension,
        unknownKeys.map((k) => ({ path: k, message: 'unknown setting' })),
      );
    }

    const current = await this.read(extension);
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
    this.cache.delete(extension);
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
    const values = await this.get(extension);
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
