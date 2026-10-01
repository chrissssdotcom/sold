import { LocalDiskStore, MediaService } from '@sold/media';
import { resolve } from 'node:path';

const holder = globalThis as unknown as { __soldMedia?: MediaService };

/**
 * The media service for this process. Storage is a local directory (`SOLD_MEDIA_DIR`, default `.data/media`): right for
 * development and a single instance. A multi-instance deployment needs an object-storage adapter behind `MediaStore`
 * (docs/media.md), because instances do not share a disk.
 */
export function getMedia(): MediaService {
  return (holder.__soldMedia ??= new MediaService(
    new LocalDiskStore(resolve(process.env['SOLD_MEDIA_DIR'] ?? '.data/media')),
  ));
}
