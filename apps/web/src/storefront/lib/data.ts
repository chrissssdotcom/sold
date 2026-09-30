import { cache } from 'react';
import { CatalogService, type CatalogProduct } from '@sold/commerce';
import { PageService } from '@sold/content';
import { getRuntime } from '../../server/runtime';
import { baseRegistry } from '../blocks/registry';

const catalog = new CatalogService();
let pages: PageService | undefined;

/**
 * Storefront reads. They use the REPLICA handle and never boot the extension kernel, so a page render costs a
 * handful of indexed queries and a busy storefront cannot load the primary. `cache()` de-duplicates within one render
 * (three blocks asking for the same products run one query).
 */
export const getProducts = cache(async (limit = 24): Promise<CatalogProduct[]> =>
  catalog.listActiveDetailed(getRuntime().db.replica, limit),
);

export const getProductsByHandles = cache(async (handlesKey: string): Promise<CatalogProduct[]> =>
  catalog.getActiveByHandles(getRuntime().db.replica, handlesKey.split(',').filter(Boolean)),
);

export const getProduct = cache(async (handle: string): Promise<CatalogProduct | null> => {
  try {
    return await catalog.getActiveByHandle(getRuntime().db.replica, handle);
  } catch (error) {
    if ((error as { code?: string }).code === 'not_found') return null;
    throw error;
  }
});

export const getAvailability = cache(
  async (ids: string): Promise<Map<string, { available: number | null }>> =>
    catalog.availability(getRuntime().db.replica, ids.split(',').filter(Boolean)),
);

export function pageService(): PageService {
  pages ??= new PageService(baseRegistry());
  return pages;
}

export const getPublishedPage = cache(async (locale: string, path: string) =>
  pageService().getPublished(getRuntime().db.replica, locale, path),
);
