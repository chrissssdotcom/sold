import { PageService } from '@sold/content';
import { blockRegistry } from '../../storefront/theme';

let service: PageService | undefined;
/** Page service for the admin, validating against the active theme's block registry. */
export function getPageService(): PageService {
  service ??= new PageService(blockRegistry());
  return service;
}
