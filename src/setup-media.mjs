import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { engineConfig } from './companion-settings.mjs';
import { prepareRecords } from './record-storage.mjs';
import { inspectImage } from './image-codec.mjs';
import { dragonReference } from './media-library.mjs';

const paths = prepareRecords(engineConfig());
const reference = join(paths.images, 'references', 'gpt.png');
if (!existsSync(reference)) {
  const response = await fetch('https://genderswapai.com/images/ai-gijinka/gpt.webp', { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error('角色参考图下载失败。');
  const bytes = Buffer.from(await response.arrayBuffer());
  const inspected = await inspectImage(bytes);
  const original = join(paths.images, 'references', 'gpt.webp');
  if (!existsSync(original)) writeFileSync(original, bytes, { flag: 'wx' });
  writeFileSync(reference, inspected.previews[0], { flag: 'wx' });
}
writeFileSync(join(paths.text, '角色识别参考.json'), JSON.stringify(dragonReference, null, 2));
console.log('图片与文字目录已准备，原有设置和记忆已复制，GPT 龙娘参考图已保存。');
