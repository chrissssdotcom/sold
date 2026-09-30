import { z } from '@sold/extension-sdk';

const href = z
  .string()
  .max(300)
  .regex(/^(\/|https?:\/\/|#)/, 'a path or URL');
const cta = z.object({ label: z.string().min(1).max(40), href });
const img = z
  .string()
  .max(300)
  .regex(/^\/[A-Za-z0-9_./-]+$|^https:\/\//, 'an image path or https URL');

export const heroProps = z.object({
  eyebrow: z.string().max(60).default(''),
  /** `*word*` renders in the accent italic. */
  heading: z.string().min(1).max(120),
  body: z.string().max(400).default(''),
  primary: cta.optional(),
  secondary: cta.optional(),
  image: img.default('/art/hero.svg'),
  proof: z.string().max(80).default(''),
});

export const featureStripProps = z.object({
  items: z
    .array(
      z.object({
        icon: z.enum(['truck', 'leaf', 'refresh', 'shield']),
        title: z.string().max(40),
        text: z.string().max(120),
      }),
    )
    .min(1)
    .max(4),
});

export const productGridProps = z.object({
  eyebrow: z.string().max(60).default(''),
  heading: z.string().max(100).default(''),
  /** Specific products, in order. Empty = newest. */
  handles: z.array(z.string().max(120)).max(24).default([]),
  limit: z.number().int().min(1).max(24).default(4),
  columns: z.union([z.literal(3), z.literal(4)]).default(4),
  viewAll: cta.optional(),
});

export const categoryTilesProps = z.object({
  eyebrow: z.string().max(60).default(''),
  heading: z.string().max(100).default(''),
  tiles: z
    .array(z.object({ label: z.string().max(40), href, image: img }))
    .min(1)
    .max(6),
});

export const editorialProps = z.object({
  eyebrow: z.string().max(60).default(''),
  heading: z.string().min(1).max(120),
  body: z.string().max(600).default(''),
  cta: cta.optional(),
  image: img.default('/art/editorial.svg'),
  reverse: z.boolean().default(false),
  tint: z.boolean().default(false),
});

export const testimonialProps = z.object({
  quote: z.string().min(1).max(260),
  author: z.string().max(60),
  role: z.string().max(80).default(''),
});

export const ctaBannerProps = z.object({
  heading: z.string().min(1).max(100),
  body: z.string().max(240).default(''),
  cta: cta.optional(),
});

export const richTextProps = z.object({
  heading: z.string().max(120).default(''),
  /** Paragraphs separated by blank lines; `## ` starts a sub-heading. */
  body: z.string().min(1).max(8000),
});

export const spacerProps = z.object({ size: z.enum(['sm', 'md', 'lg']).default('md') });
export const columnsProps = z.object({ count: z.number().int().min(1).max(3).default(2) });
