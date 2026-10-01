import { z } from 'zod';
import { ValidationError } from '@sold/commerce';
import { readJson } from '../commerce-http';

export const idParam = z.uuid();

/** Validate a path parameter; anything malformed is a clean 422, never a database error. */
export function parseId(value: string | undefined): string {
  const r = idParam.safeParse(value);
  if (!r.success) throw new ValidationError('Invalid id');
  return r.data;
}

export const listQuery = z.object({
  q: z.string().max(100).optional(),
  status: z.string().max(30).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  before: z.uuid().optional(),
});

export function queryOf(request: Request): Record<string, string> {
  return Object.fromEntries(new URL(request.url).searchParams);
}

export const body = async <T extends z.ZodType>(request: Request, schema: T, max = 256 * 1024) =>
  schema.parse(await readJson(request, max)) as z.output<T>;
