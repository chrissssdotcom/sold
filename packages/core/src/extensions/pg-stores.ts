import { and, eq, inArray, isNull, schema, type PrimaryDb } from '@sold/db';

const { extensionRegistry, extensionSettings } = schema;
import type { SettingsRow, SettingsStore } from './settings';

/**
 * Postgres-backed settings store. Reads and writes use the primary: settings are low-volume and an admin
 * who just saved a value must read it back (read-your-writes).
 */
export class PgSettingsStore implements SettingsStore {
  constructor(private readonly db: PrimaryDb) {}

  async load(extension: string): Promise<SettingsRow[]> {
    const rows = await this.db
      .select()
      .from(extensionSettings)
      .where(eq(extensionSettings.extension, extension));
    return rows.map((r) => ({ key: r.key, value: r.value, ciphertext: r.ciphertext }));
  }

  async loadSecrets(): Promise<(SettingsRow & { extension: string })[]> {
    const rows = await this.db
      .select()
      .from(extensionSettings)
      .where(isNull(extensionSettings.value));
    return rows
      .filter((r) => r.ciphertext !== null)
      .map((r) => ({ extension: r.extension, key: r.key, value: null, ciphertext: r.ciphertext }));
  }

  async save(
    extension: string,
    changes: { upsert: SettingsRow[]; remove: string[]; actor: string },
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      for (const row of changes.upsert) {
        await tx
          .insert(extensionSettings)
          .values({
            extension,
            key: row.key,
            value: row.ciphertext === null ? row.value : null,
            ciphertext: row.ciphertext,
            updatedBy: changes.actor,
          })
          .onConflictDoUpdate({
            target: [extensionSettings.extension, extensionSettings.key],
            set: {
              value: row.ciphertext === null ? row.value : null,
              ciphertext: row.ciphertext,
              updatedBy: changes.actor,
              updatedAt: new Date(),
            },
          });
      }
      if (changes.remove.length > 0) {
        await tx
          .delete(extensionSettings)
          .where(
            and(
              eq(extensionSettings.extension, extension),
              inArray(extensionSettings.key, changes.remove),
            ),
          );
      }
    });
  }
}

/**
 * `installing`: the row exists but `onInstall` has not yet succeeded. It is stored as `state = 'disabled'` with neither
 * `last_enabled_at` nor `last_disabled_at` set (the table's CHECK allows only enabled/disabled, and Base migrations
 * are not changed for this): a state no completed lifecycle can produce, because every completed transition stamps one.
 */
export type ExtensionState = 'enabled' | 'disabled' | 'installing';

export interface RegistryRow {
  name: string;
  version: string;
  state: ExtensionState;
}

/** Installed/enabled state per extension; drives lifecycle hooks on transitions. */
export class PgExtensionRegistry {
  constructor(private readonly db: PrimaryDb) {}

  async list(): Promise<RegistryRow[]> {
    const rows = await this.db.select().from(extensionRegistry);
    return rows.map((r) => ({
      name: r.name,
      version: r.version,
      state:
        r.state === 'disabled' && r.lastEnabledAt === null && r.lastDisabledAt === null
          ? 'installing'
          : (r.state as ExtensionState),
    }));
  }

  /** Record that an install started (state `installing`, see `ExtensionState`). Idempotent. */
  async beginInstall(name: string, version: string): Promise<void> {
    await this.db
      .insert(extensionRegistry)
      .values({ name, version, state: 'disabled' })
      .onConflictDoNothing();
  }

  async upsert(name: string, version: string, state: 'enabled' | 'disabled'): Promise<void> {
    const now = new Date();
    const stamps = state === 'enabled' ? { lastEnabledAt: now } : { lastDisabledAt: now };
    await this.db
      .insert(extensionRegistry)
      .values({ name, version, state, ...stamps })
      .onConflictDoUpdate({ target: extensionRegistry.name, set: { version, state, ...stamps } });
  }

  async remove(name: string): Promise<void> {
    await this.db.delete(extensionRegistry).where(eq(extensionRegistry.name, name));
  }
}
