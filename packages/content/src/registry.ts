import type { BlockDefinition } from '@sold/extension-sdk';

export interface RegisteredBlock {
  def: BlockDefinition;
  /** May hold child blocks (columns, sections). Extension blocks are leaves. */
  container: boolean;
}

/**
 * The set of block types a page may use: Base blocks plus those contributed by enabled extensions
 * (namespaced `<extension>/<type>`). Built once at boot; validation and rendering both read it, so a page can only
 * ever contain blocks that exist, and removing an extension makes its blocks fail validation rather than crash a render.
 */
export class BlockRegistry {
  private readonly blocks = new Map<string, RegisteredBlock>();

  register(def: BlockDefinition, opts: { container?: boolean } = {}): this {
    if (this.blocks.has(def.type)) throw new Error(`Duplicate block type "${def.type}"`);
    if (!/^[a-z][a-z0-9-]*(\/[a-z][a-z0-9-]*)?$/.test(def.type))
      throw new Error(`Invalid block type "${def.type}"`);
    this.blocks.set(def.type, { def, container: opts.container ?? false });
    return this;
  }

  get(type: string): RegisteredBlock | undefined {
    return this.blocks.get(type);
  }

  list(): RegisteredBlock[] {
    return [...this.blocks.values()];
  }
}
