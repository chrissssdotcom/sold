import { z } from 'zod';
import { instanceMarkerSchema } from './upgrade/drift';
import { baseManifestSchema } from './upgrade/manifest';
import { releaseJsonSchema } from './release/schemas';

/** JSON Schemas for the files under `.sold/` and `environments/`, generated from the Zod sources of truth. */
export function generateJsonSchemas(): Record<string, unknown> {
  const withMeta = (id: string, title: string, schema: z.ZodType): Record<string, unknown> => ({
    $id: id,
    title,
    ...z.toJSONSchema(schema, { target: 'draft-2020-12' }),
  });
  return {
    'release.schema.json': withMeta(
      'urn:sold:schema:release',
      'environments/<env>/release.json',
      releaseJsonSchema,
    ),
    'base-manifest.schema.json': withMeta(
      'urn:sold:schema:base-manifest',
      '.sold/base-manifest.json',
      baseManifestSchema,
    ),
    'instance.schema.json': withMeta(
      'urn:sold:schema:instance',
      '.sold/instance.json',
      instanceMarkerSchema,
    ),
  };
}

export function serializeSchema(schema: unknown): string {
  return `${JSON.stringify(schema, null, 2)}\n`;
}
