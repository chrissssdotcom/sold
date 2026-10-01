import { PageService } from '@sold/content';
import { createSchemaRegistry } from '@sold/storefront/blocks';

/**
 * Read-side page access for admin PAGES (server components). It uses the schema-only registry on purpose: the themed
 * registry imports the active theme, and a theme's CSS imported anywhere in a page's module graph is bundled into that
 * page, which would restyle the console. Route handlers (which ship no CSS) use `getPageService()` instead.
 */
export const pageReader = new PageService(createSchemaRegistry());
