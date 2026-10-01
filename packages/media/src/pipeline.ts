import sharp from 'sharp';

export class MediaRejected extends Error {
  constructor(
    readonly code: 'unsupported_type' | 'too_large' | 'too_many_pixels' | 'corrupt',
    message: string,
  ) {
    super(message);
    this.name = 'MediaRejected';
  }
}

export const LIMITS = {
  maxBytes: 12 * 1024 * 1024,
  /** Decompression-bomb guard: a small file can expand to gigabytes of pixels. */
  maxPixels: 40_000_000,
  widths: [320, 640, 1024, 1600, 2400] as const,
} as const;

/** Only raster formats we can re-encode. SVG is refused on purpose: it is a document that can carry script. */
const FORMATS: Record<string, { mime: string; ext: string }> = {
  jpeg: { mime: 'image/jpeg', ext: 'jpg' },
  png: { mime: 'image/png', ext: 'png' },
  webp: { mime: 'image/webp', ext: 'webp' },
  gif: { mime: 'image/gif', ext: 'gif' },
  avif: { mime: 'image/avif', ext: 'avif' },
};

export interface Rendition {
  file: string;
  width: number;
  mime: string;
  data: Buffer;
}

export interface Processed {
  width: number;
  height: number;
  mime: string;
  /** The normalised original first (`orig.<ext>`), then one WebP per width not larger than the source. */
  renditions: Rendition[];
}

/**
 * Validate and re-encode an upload. The input is never trusted or stored as is: the format comes from the DECODED image
 * (not the file name or the claimed type), the image is re-encoded (so any appended payload or polyglot is discarded),
 * metadata (EXIF, GPS, ICC) is stripped, and orientation is applied first so stripping EXIF does not rotate photos.
 */
export async function processImage(input: Buffer): Promise<Processed> {
  if (input.length === 0 || input.length > LIMITS.maxBytes)
    throw new MediaRejected(
      'too_large',
      `Images must be under ${LIMITS.maxBytes / 1024 / 1024} MB`,
    );
  let meta: sharp.Metadata;
  try {
    meta = await sharp(input, { limitInputPixels: LIMITS.maxPixels, failOn: 'error' }).metadata();
  } catch (error) {
    const msg = error instanceof Error ? error.message : '';
    if (/pixel limit/i.test(msg))
      throw new MediaRejected('too_many_pixels', 'That image has too many pixels');
    throw new MediaRejected(
      'unsupported_type',
      'That file is not a supported image (JPEG, PNG, WebP, GIF or AVIF)',
    );
  }
  const format = meta.format ? FORMATS[meta.format] : undefined;
  if (!format || !meta.width || !meta.height)
    throw new MediaRejected(
      'unsupported_type',
      'That file is not a supported image (JPEG, PNG, WebP, GIF or AVIF)',
    );
  if (meta.width * meta.height > LIMITS.maxPixels)
    throw new MediaRejected('too_many_pixels', 'That image has too many pixels');

  try {
    // Animated GIFs: keep the first frame as a still (animation is a different feature and a size/CPU risk).
    const base = () => sharp(input, { limitInputPixels: LIMITS.maxPixels, pages: 1 }).rotate();
    const original = await (
      meta.format === 'jpeg'
        ? base().jpeg({ quality: 88, mozjpeg: true })
        : meta.format === 'png'
          ? base().png({ compressionLevel: 9 })
          : meta.format === 'gif'
            ? base().png()
            : meta.format === 'avif'
              ? base().avif({ quality: 60 })
              : base().webp({ quality: 88 })
    ).toBuffer({ resolveWithObject: true });

    const outFormat = meta.format === 'gif' ? FORMATS['png']! : format;
    const width = original.info.width;
    const height = original.info.height;
    const renditions: Rendition[] = [
      { file: `orig.${outFormat.ext}`, width, mime: outFormat.mime, data: original.data },
    ];
    for (const w of LIMITS.widths) {
      if (w > width) continue; // never upscale
      renditions.push({
        file: `${w}.webp`,
        width: w,
        mime: 'image/webp',
        data: await sharp(original.data)
          .resize({ width: w, withoutEnlargement: true })
          .webp({ quality: 80 })
          .toBuffer(),
      });
    }
    // A source narrower than every width still gets one WebP at its own size.
    if (renditions.length === 1)
      renditions.push({
        file: `${width}.webp`,
        width,
        mime: 'image/webp',
        data: await sharp(original.data).webp({ quality: 80 }).toBuffer(),
      });
    return { width, height, mime: outFormat.mime, renditions };
  } catch (error) {
    if (error instanceof MediaRejected) throw error;
    throw new MediaRejected('corrupt', 'That image could not be read');
  }
}
