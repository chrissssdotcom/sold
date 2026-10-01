import { z } from '@sold/extension-sdk';

/** Strip control characters (keeping newlines and tabs) and collapse runaway blank lines: reviews are plain text. */
export function cleanText(value: string): string {
  let out = '';
  for (const ch of value) {
    const code = ch.codePointAt(0)!;
    const control = code < 0x20 ? code !== 0x0a && code !== 0x09 : code === 0x7f;
    if (!control) out += ch;
  }
  return out.replace(/\n{3,}/g, '\n\n').trim();
}

export const reviewInput = z.strictObject({
  rating: z.number().int().min(1).max(5),
  title: z
    .string()
    .max(120)
    .default('')
    .transform((s) => cleanText(s)),
  body: z
    .string()
    .max(4000)
    .transform((s) => cleanText(s))
    .pipe(z.string().min(1, 'Please write a few words')),
  authorName: z
    .string()
    .max(60)
    .default('')
    .transform((s) => cleanText(s).replace(/\s+/g, ' ')),
});

export const moderationInput = z.strictObject({ status: z.enum(['approved', 'rejected']) });

export const uuidParam = z.uuid();

export interface Summary {
  count: number;
  average: number;
  distribution: Record<'1' | '2' | '3' | '4' | '5', number>;
}

/** Round to one decimal for display; the stored ratings are integers so this is the only place a float appears. */
export const roundAverage = (sum: number, count: number): number =>
  count === 0 ? 0 : Math.round((sum / count) * 10) / 10;
