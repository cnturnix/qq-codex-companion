import { mkdirSync, existsSync, copyFileSync, constants } from 'node:fs';
import { resolve, join } from 'node:path';

export function recordPaths(config) {
  const root = resolve(config.recordRoot ?? join(config.runtime, 'records'));
  return { root, text: resolve(config.textRoot ?? join(root, 'txt')), images: join(root, 'img') };
}
export function prepareRecords(config) {
  const paths = recordPaths(config);
  for (const dir of [paths.text, ...['stickers', 'images', 'previews', 'references'].map(name => join(paths.images, name))]) mkdirSync(dir, { recursive: true });
  // Copy only when no new store exists. Original files remain as migration backups.
  for (const name of ['companion.json', 'settings.json']) {
    const source = resolve(config.runtime, name), destination = join(paths.text, name);
    if (source !== destination && existsSync(source) && !existsSync(destination)) copyFileSync(source, destination, constants.COPYFILE_EXCL);
  }
  for (const name of ['server.log', 'server-error.log']) {
    const source = resolve(config.runtime, name), destination = join(paths.text, 'legacy-' + name);
    if (existsSync(source) && !existsSync(destination)) copyFileSync(source, destination, constants.COPYFILE_EXCL);
  }
  return paths;
}
