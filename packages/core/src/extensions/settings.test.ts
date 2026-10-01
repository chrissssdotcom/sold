import { randomBytes } from 'node:crypto';
import { defineExtension, z } from '@sold/extension-sdk';
import { describe, expect, it } from 'vitest';
import { EnvelopeCrypto, rootKeyFromBase64 } from '../crypto/envelope';
import {
  SettingsService,
  SettingsValidationError,
  type AuditEntry,
  type SettingsRow,
  type SettingsStore,
} from './settings';

class MemoryStore implements SettingsStore {
  rows = new Map<string, SettingsRow[]>();
  saves = 0;
  async load(ext: string) {
    return structuredClone(this.rows.get(ext) ?? []);
  }
  async loadSecrets() {
    return [...this.rows.entries()].flatMap(([extension, rows]) =>
      rows.filter((r) => r.ciphertext !== null).map((r) => ({ extension, ...structuredClone(r) })),
    );
  }
  async save(ext: string, c: { upsert: SettingsRow[]; remove: string[] }) {
    this.saves++;
    const byKey = new Map((this.rows.get(ext) ?? []).map((r) => [r.key, r]));
    for (const k of c.remove) byKey.delete(k);
    for (const r of c.upsert) byKey.set(r.key, r);
    this.rows.set(ext, [...byKey.values()]);
  }
}

const manifest = defineExtension({
  name: 'loyalty',
  version: '1.0.0',
  requires: { base: '*' },
  performance: { hotPath: false },
  settings: {
    schema: z.object({
      pointsPerDollar: z.number().int().min(1).max(100).default(1),
      programName: z
        .string()
        .default('Rewards')
        .meta({ title: 'Program name', description: 'Shown to shoppers' }),
      apiToken: z.string().min(8).optional(),
    }),
    secrets: ['apiToken'],
  },
});

function setup(now = () => 1_000) {
  const store = new MemoryStore();
  const audit: AuditEntry[] = [];
  const svc = new SettingsService({
    store,
    crypto: new EnvelopeCrypto(rootKeyFromBase64(randomBytes(32).toString('base64'))),
    audit: { record: async (e) => void audit.push(e) },
    ttlMs: 1_000,
    now,
  });
  svc.register(manifest);
  return { svc, store, audit };
}

describe('SettingsService', () => {
  it('a fresh install parses to defaults', async () => {
    expect(await setup().svc.get('loyalty')).toEqual({
      pointsPerDollar: 1,
      programName: 'Rewards',
    });
  });

  it('stores secrets encrypted and everything else as plain JSON', async () => {
    const { svc, store } = setup();
    await svc.set('loyalty', { pointsPerDollar: 5, apiToken: 'tok_live_12345678' }, 'admin-1');
    const rows = store.rows.get('loyalty') ?? [];
    expect(rows.find((r) => r.key === 'pointsPerDollar')).toMatchObject({
      value: 5,
      ciphertext: null,
    });
    const secret = rows.find((r) => r.key === 'apiToken');
    expect(secret?.value).toBeNull();
    expect(JSON.stringify(rows)).not.toContain('tok_live_12345678');
    expect(await svc.get('loyalty')).toMatchObject({
      pointsPerDollar: 5,
      apiToken: 'tok_live_12345678',
    });
  });

  it('absent keys are unchanged; null clears a secret', async () => {
    const { svc } = setup();
    await svc.set('loyalty', { apiToken: 'tok_live_12345678', programName: 'Club' }, 'a');
    await svc.set('loyalty', { pointsPerDollar: 2 }, 'a');
    expect(await svc.get('loyalty')).toMatchObject({
      apiToken: 'tok_live_12345678',
      programName: 'Club',
      pointsPerDollar: 2,
    });
    await svc.set('loyalty', { apiToken: null }, 'a');
    expect((await svc.get('loyalty')).apiToken).toBeUndefined();
  });

  it('null resets a defaulted setting to its default and unsets an optional one (instead of failing validation)', async () => {
    const { svc, store } = setup();
    await svc.set('loyalty', { programName: 'Club', pointsPerDollar: 5 }, 'a');
    await svc.set('loyalty', { programName: null }, 'a');
    expect(await svc.get('loyalty')).toMatchObject({ programName: 'Rewards', pointsPerDollar: 5 });
    // No stored row for the reset key: a future change to the default takes effect.
    expect((await store.load('loyalty')).map((r) => r.key)).toEqual(['pointsPerDollar']);
  });

  it('validates before writing: a bad patch changes nothing', async () => {
    const { svc, store } = setup();
    await expect(svc.set('loyalty', { pointsPerDollar: 1000 }, 'a')).rejects.toBeInstanceOf(
      SettingsValidationError,
    );
    await expect(svc.set('loyalty', { apiToken: 'short' }, 'a')).rejects.toThrow(/apiToken/);
    await expect(svc.set('loyalty', { nope: 1 }, 'a')).rejects.toThrow(/unknown setting/);
    expect(store.saves).toBe(0);
  });

  it('audits key names only, never values', async () => {
    const { svc, audit } = setup();
    await svc.set('loyalty', { apiToken: 'tok_live_12345678', pointsPerDollar: 3 }, 'admin-7');
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      action: 'extension.settings.updated',
      actor: 'admin-7',
      extension: 'loyalty',
      changedKeys: ['apiToken', 'pointsPerDollar'],
    });
    expect(JSON.stringify(audit)).not.toContain('tok_live');
  });

  it('a no-op patch writes and audits nothing', async () => {
    const { svc, store, audit } = setup();
    await svc.set('loyalty', {}, 'a');
    expect(store.saves).toBe(0);
    expect(audit).toEqual([]);
  });

  it('serves an in-memory snapshot for hot paths and refreshes after the TTL', async () => {
    let t = 1_000;
    const { svc, store } = setup(() => t);
    expect(svc.snapshot('loyalty')).toBeUndefined();
    await svc.warm();
    expect(svc.snapshot('loyalty')).toEqual({ pointsPerDollar: 1, programName: 'Rewards' });
    store.rows.set('loyalty', [{ key: 'pointsPerDollar', value: 9, ciphertext: null }]);
    expect((await svc.get('loyalty')).pointsPerDollar).toBe(1); // cached
    t += 1_001;
    expect((await svc.get('loyalty')).pointsPerDollar).toBe(9);
  });

  it('describes the admin form without leaking secrets', async () => {
    const { svc } = setup();
    await svc.set('loyalty', { apiToken: 'tok_live_12345678' }, 'a');
    const form = await svc.describeForm('loyalty');
    const token = form.find((f) => f.key === 'apiToken');
    expect(token).toMatchObject({ secret: true, hasValue: true });
    expect(token && 'value' in token).toBe(false);
    expect(JSON.stringify(form)).not.toContain('tok_live');
    expect(form.find((f) => f.key === 'programName')).toMatchObject({
      title: 'Program name',
      description: 'Shown to shoppers',
      default: 'Rewards',
      secret: false,
    });
  });

  it('falls back to defaults when stored data no longer matches the schema (after an upgrade)', async () => {
    const { svc, store } = setup();
    store.rows.set('loyalty', [
      { key: 'pointsPerDollar', value: 'not-a-number', ciphertext: null },
    ]);
    expect((await svc.get('loyalty')).pointsPerDollar).toBe(1);
  });

  it('refuses extensions that declare no settings', async () => {
    await expect(setup().svc.get('other')).rejects.toThrow(/declares no settings/);
  });
});
