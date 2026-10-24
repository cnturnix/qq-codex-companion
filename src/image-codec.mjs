import { createRequire } from 'node:module';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const require = createRequire(import.meta.url);
let sharp;
export function imageProcessor() {
  if (!sharp) {
    try { sharp = require('sharp'); }
    catch { sharp = require(join(process.env.USERPROFILE ?? '', '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/sharp')); }
  }
  return sharp;
}
export const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
export async function inspectImage(bytes) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new Error('图片须为 12 MB 以内的 PNG、JPEG、WebP 或 GIF。');
  const image = imageProcessor(), opts = { limitInputPixels: 40_000_000 };
  const metadata = await image(bytes, opts).metadata();
  const types = { png: ['png', 'image/png'], jpeg: ['jpg', 'image/jpeg'], webp: ['webp', 'image/webp'], gif: ['gif', 'image/gif'] };
  if (!types[metadata.format]) throw new Error('只支持 PNG、JPEG、WebP、GIF 图片。');
  const pages = metadata.pages ?? 1;
  const frames = [...new Set([0, ...(pages > 1 ? [Math.floor(pages / 2), pages - 1] : [])])];
  const previews = [];
  for (const page of frames) previews.push(await image(bytes, { ...opts, page, pages: 1 }).rotate().resize(1280, 1280, { fit: 'inside', withoutEnlargement: true }).png().toBuffer());
  // Hash full-resolution static pixels. Sampled animation frames are not an identity check.
  const pixelHash = createHash('sha256');
  if (pages > 1) pixelHash.update(bytes);
  else {
    const decoded = await image(bytes, opts).rotate().ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    pixelHash.update(`${decoded.info.width}:${decoded.info.height}:`);
    pixelHash.update(decoded.data);
  }
  return { ext: types[metadata.format][0], mime: types[metadata.format][1], width: metadata.width, height: metadata.pageHeight ?? metadata.height, pages, previews, pixelHash: pixelHash.digest('hex') };
}
