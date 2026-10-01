import { mkdir, readFile, rm, stat, writeFile, rename } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';

/** Where the bytes live. Swap the adapter (object storage) without touching the pipeline or the routes. */
export interface MediaStore {
  put(key: string, data: Buffer): Promise<void>;
  get(key: string): Promise<Buffer | null>;
  /** Remove every object whose key starts with `prefix/`. */
  deletePrefix(prefix: string): Promise<void>;
}

const KEY = /^[0-9a-f-]{36}\/[a-z0-9]+\.[a-z0-9]+$/;

/**
 * A directory on local disk. Fine for development and a single instance; **not shared between instances**, so a multi-instance
 * deployment needs an object-storage adapter (not built yet: docs/media.md). Keys are validated to a fixed shape, then resolved
 * and checked to stay inside the root, so no key can reach outside it.
 */
export class LocalDiskStore implements MediaStore {
  private readonly root: string;
  constructor(root: string) {
    this.root = resolve(root);
  }
  private path(key: string): string {
    if (!KEY.test(key)) throw new Error('invalid media key');
    const p = resolve(join(this.root, key));
    if (!p.startsWith(this.root + sep)) throw new Error('invalid media key');
    return p;
  }
  async put(key: string, data: Buffer): Promise<void> {
    const p = this.path(key);
    await mkdir(dirname(p), { recursive: true });
    // Write then rename: a reader never sees half a file.
    const tmp = `${p}.${randomUUID()}.tmp`;
    await writeFile(tmp, data);
    await rename(tmp, p);
  }
  async get(key: string): Promise<Buffer | null> {
    try {
      const p = this.path(key);
      await stat(p);
      return await readFile(p);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      if (error instanceof Error && error.message === 'invalid media key') return null;
      throw error;
    }
  }
  async deletePrefix(prefix: string): Promise<void> {
    if (!/^[0-9a-f-]{36}$/.test(prefix)) throw new Error('invalid media prefix');
    await rm(join(this.root, prefix), { recursive: true, force: true });
  }
}

/** In memory, for tests. */
export class MemoryStore implements MediaStore {
  readonly files = new Map<string, Buffer>();
  async put(key: string, data: Buffer) {
    this.files.set(key, data);
  }
  async get(key: string) {
    return this.files.get(key) ?? null;
  }
  async deletePrefix(prefix: string) {
    for (const k of [...this.files.keys()]) if (k.startsWith(`${prefix}/`)) this.files.delete(k);
  }
}
