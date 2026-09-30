import { and, eq, inArray, schema, type PrimaryDb } from '@sold/db';

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

export type ExtensionState = 'enabled' | 'disabled';

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
      state: r.state as ExtensionState,
    }));
  }

  async upsert(name: string, version: string, state: ExtensionState): Promise<void> {
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
