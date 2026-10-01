# Media library

Console > Media. Upload product and page images; the page builder's image fields have a "Choose from library" button that fills in a good WebP rendition.

## What happens to an upload (`packages/media`)

1. **Validated by decoding**, not by file name or claimed type: JPEG, PNG, WebP, GIF, AVIF only. **SVG is refused** (a document that can carry script). Over 12 MB or over 40 megapixels is refused (decompression-bomb guard: a tiny file can expand to gigabytes of pixels).
2. **Re-encoded**, never stored as received, so anything appended to an image (polyglot payloads) is discarded. EXIF orientation is applied, then **all metadata (GPS, camera, ICC) is stripped**. Animated GIFs become a still PNG.
3. **Renditions:** the normalised original plus WebP at 320, 640, 1024, 1600 and 2400 px, never upscaled (a small image gets one WebP at its own size).
4. **Deduplicated** by SHA-256 of the uploaded bytes (also under concurrent uploads).
5. A failed write rolls the catalogue row back, so a row never points at missing files.

Serving: `/media/<id>/<file>` is public, `Cache-Control: public, max-age=31536000, immutable` (ids are random and files never change), `X-Content-Type-Options: nosniff`, and a `default-src 'none'; sandbox` policy. Only files listed in the catalogue are served; keys are validated to a fixed shape and
confined to the media directory.

Admin API: `GET/POST /api/admin/media` (POST body = raw image bytes, `?name=`; `content:write`), `PATCH/DELETE /api/admin/media/:id`. Alt text is editable in the library; images in the grid use it.

## Verified

11 unit tests (EXIF stripping with a planted camera string, appended-payload removal, SVG/HTML/text/empty/truncated refusal, bomb refusal, no upscaling, PNG transparency, GIF), 4 integration tests against Postgres (dedupe under concurrency, rollback, cursor paging, delete removes files), and e2e over HTTP and in Chromium
(upload through the file input, immutable serving headers, traversal attempts all 404, SVG and a "PHP file named .png" both refused with 422, unauthenticated and cross-site uploads refused, axe clean).

## Not built (read before production)

- **Storage is a local directory** (`SOLD_MEDIA_DIR`, default `.data/media`). Instances do not share a disk, so **a multi-instance deployment needs an object-storage adapter** behind the `MediaStore` interface (Azure Blob / S3). The interface and the pipeline are ready for it; the adapter is not written, and I will not claim one I could not test.
- Rendition generation is **synchronous inside the upload request** (fine for staff uploading a few images; not for bulk imports: move it to a job).
- No AVIF renditions, no focal-point cropping, no usage tracking (deleting an image that a page still uses leaves a broken image; the console warns), no video, no folders or tags.
- The CDN is expected to cache `/media/*` (Section 8B); nothing here purges it because URLs are immutable.
