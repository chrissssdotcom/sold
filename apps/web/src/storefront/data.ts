import { cache } from 'react';
import { CatalogService, type CatalogProduct } from '@sold/commerce';
import { PageService } from '@sold/content';
import { eq, schema } from '@sold/db';
import { validateTokens, type StockMap, type StorefrontData } from '@sold/storefront';
import { getRuntime } from '../server/runtime';
import { blockRegistry } from './theme';

const catalog = new CatalogService();
let pages: PageService | undefined;

/**
 * Storefront reads. They use the REPLICA handle and never boot the extension kernel, so a page render costs a handful
 * of indexed queries and a busy storefront cannot load the primary. `cache()` de-duplicates within one render.
 */
const products = cache(async (limit: number): Promise<CatalogProduct[]> =>
  catalog.listActiveDetailed(getRuntime().db.replica, limit),
);
const byHandles = cache(async (key: string): Promise<CatalogProduct[]> =>
  catalog.getActiveByHandles(getRuntime().db.replica, key.split(',').filter(Boolean)),
);
const availability = cache(async (key: string): Promise<StockMap> =>
  catalog.availability(getRuntime().db.replica, key.split(',').filter(Boolean)),
);

/** The data surface themes and blocks are allowed to read. A theme never receives a database handle. */
export const storefrontData: StorefrontData = {
  products: (limit) => products(limit),
  productsByHandles: (handles) => byHandles(handles.join(',')),
  availability: (ids) => availability([...ids].sort().join(',')),
};

export const getProduct = cache(async (handle: string): Promise<CatalogProduct | null> => {
  try {
    return await catalog.getActiveByHandle(getRuntime().db.replica, handle);
  } catch (error) {
    if ((error as { code?: string }).code === 'not_found') return null;
    throw error;
  }
});

export function pageService(): PageService {
  pages ??= new PageService(blockRegistry());
  return pages;
}

export const getPublishedPage = cache(async (locale: string, path: string) =>
  pageService().getPublished(getRuntime().db.replica, locale, path),
);

/**
 * Operator design tokens from `theme_settings` (set in the admin without a deploy). Validated again on read: a bad row is
 * ignored, never injected. They layer over the theme's own tokens.
 */
export const getThemeTokens = cache(async (): Promise<Record<string, string>> => {
  const [row] = await getRuntime()
    .db.replica.select({ tokens: schema.themeSettings.tokens })
    .from(schema.themeSettings)
    .where(eq(schema.themeSettings.id, true));
  const tokens = (row?.tokens ?? {}) as Record<string, unknown>;
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(tokens)) {
    if (typeof v !== 'string') continue;
    try {
      validateTokens({ [k]: v }, 'theme_settings');
      clean[k] = v;
    } catch {
      /* ignore invalid */
    }
  }
  return clean;
});
