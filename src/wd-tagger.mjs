import { existsSync, readFileSync, mkdirSync, createReadStream, createWriteStream, renameSync, unlinkSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { atomicJson } from './companion-settings.mjs';
import { imageProcessor } from './image-codec.mjs';
import { mediaFetch, smallJson } from './media-network.mjs';

export const WD_REPO = 'SmilingWolf/wd-swinv2-tagger-v3';
export function parseTagCsv(text) {
  const rows = []; let row = [], value = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') { if (quoted && text[i + 1] === '"') { value += '"'; i++; } else quoted = !quoted; }
    else if (!quoted && (c === ',' || c === '\n')) { row.push(value.replace(/\r$/, '')); value = ''; if (c === '\n') { rows.push(row); row = []; } }
    else value += c;
  }
  if (value || row.length) { row.push(value.replace(/\r$/, '')); rows.push(row); }
  const head = rows.shift() ?? [], name = head.indexOf('name'), category = head.indexOf('category');
  if (name < 0 || category < 0 || quoted) throw Error('WD 标签文件无效。');
  return rows.filter(r => r[name]).map(r => ({ name: r[name], category: Number(r[category]) }));
}
export async function wdPixels(path, size = 448) {
  const sharp = imageProcessor();
  const meta = await sharp(path).metadata(), edge = Math.max(meta.width, meta.height);
  const left = Math.floor((edge - meta.width) / 2), top = Math.floor((edge - meta.height) / 2);
  const rgb = await sharp(path).flatten({ background: '#ffffff' }).removeAlpha().toColourspace('srgb')
    .extend({ left, right: edge - meta.width - left, top, bottom: edge - meta.height - top, background: '#ffffff' })
    .resize(size, size, { kernel: 'cubic' }).raw().toBuffer();
  const bgr = new Float32Array(size * size * 3);
  for (let i = 0; i < rgb.length; i += 3) { bgr[i] = rgb[i + 2]; bgr[i + 1] = rgb[i + 1]; bgr[i + 2] = rgb[i]; }
  return bgr;
}
export function rankWd(scores, labels, general = .6, character = .9) {
  return labels.map((t, i) => ({ ...t, score: Number(scores[i]) })).filter(t => Number.isFinite(t.score) &&
    (t.category === 0 && t.score >= general || t.category === 4 && t.score >= character))
    .sort((a, b) => b.score - a.score).slice(0, 45);
}
export async function verifyWdFile(path, spec) {
  if (!existsSync(path) || statSync(path).size !== spec.size) return false;
  const digest = createHash(spec.lfs ? 'sha256' : 'sha1');
  if (!spec.lfs) digest.update(`blob ${spec.size}\0`);
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest('hex') === (spec.lfs?.sha256 ?? spec.blobId);
}
export class WdTagger {
  constructor(config, settings, { fetcher = mediaFetch(config.codexProxy), now = Date.now, log = () => {} } = {}) {
    this.root = join(config.runtime, 'models', 'wd'); mkdirSync(this.root, { recursive: true });
    this.file = join(this.root, 'current.json'); this.settings = settings; this.fetch = fetcher; this.now = now; this.log = log;
    try { this.manifest = JSON.parse(readFileSync(this.file, 'utf8')); } catch { this.manifest = {}; }
    this.phase = 'idle'; this.error = ''; this.closed = false;
  }
  status() { return { enabled: this.settings.value.wdEnabled, repo: WD_REPO, revision: this.manifest.revision ?? '', phase: this.phase,
    ready: !!this.active, installed: !!this.manifest.revision, progress: this.progress ?? 0, checkedAt: this.manifest.checkedAt ?? 0, error: this.error }; }
  start() {
    void this.loadCurrent().then(() => this.settings.value.wdAutoUpdate && this.settings.value.wdEnabled ? this.update() : null).catch(() => {});
    this.timer = setInterval(() => { if (this.settings.value.wdEnabled && this.settings.value.wdAutoUpdate) void this.update(); }, 3600000); this.timer.unref();
  }
  async loadBundle(revision) {
    if (!/^[a-f0-9]{40}$/.test(revision)) throw Error('WD 版本无效。');
    const ort = await import('onnxruntime-node');
    const labels = parseTagCsv(readFileSync(join(this.root, revision, 'selected_tags.csv'), 'utf8'));
    const session = await ort.InferenceSession.create(join(this.root, revision, 'model.onnx'), { executionProviders: ['cpu'], intraOpNumThreads: 2, interOpNumThreads: 1 });
    try {
      const result = await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', new Float32Array(448 * 448 * 3), [1, 448, 448, 3]) });
      const values = result[session.outputNames[0]]?.data;
      if (values?.length !== labels.length || !values.every(Number.isFinite)) throw Error('WD 模型与标签不匹配。');
      return { ort, session, labels, revision };
    } catch (e) { await session.release(); throw e; }
  }
  async loadCurrent() {
    if (this.active || !this.manifest.revision || !this.settings.value.wdEnabled) return;
    try { this.active = await this.loadBundle(this.manifest.revision); this.phase = 'ready'; }
    catch { this.error = '本地模型暂不可用，可检查更新重新安装。'; this.phase = 'error'; }
  }
  update(force = false) {
    if (this.closed || this.updating) return this.updating;
    if (!force && this.manifest.checkedAt && this.now() - this.manifest.checkedAt < 86400000) return Promise.resolve(this.status());
    this.updating = this.performUpdate().finally(() => { this.updating = null; }); return this.updating;
  }
  async download(revision, spec, path) {
    if (await verifyWdFile(path, spec)) return;
    const temporary = path + '.part'; let url = `https://huggingface.co/${WD_REPO}/resolve/${revision}/${spec.rfilename}?download=true`;
    const max = spec.rfilename === 'model.onnx' ? 650 * 1024 * 1024 : 2 * 1024 * 1024;
    if (spec.size > max) throw Error('模型文件大小无效。');
    if (existsSync(temporary) && statSync(temporary).size > spec.size) unlinkSync(temporary);
    let failures = 0;
    while ((existsSync(temporary) ? statSync(temporary).size : 0) < spec.size) {
      const start = existsSync(temporary) ? statSync(temporary).size : 0, end = Math.min(spec.size - 1, start + 4 * 1024 * 1024 - 1);
      try {
        let response;
        for (let hop = 0; hop < 6; hop++) {
          const host = new URL(url).hostname;
          if (!(host === 'huggingface.co' || host.endsWith('.huggingface.co') || host.endsWith('.hf.co'))) throw Error('模型下载跳转域名无效。');
          response = await this.fetch(url, { headers: { Range: `bytes=${start}-${end}` }, signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(60000)]) });
          if ([301, 302, 303, 307, 308].includes(response.status)) { const next = response.headers.get('location'); await response.body?.cancel(); url = new URL(next, url).href; continue; }
          break;
        }
        const range = response?.headers.get('content-range');
        const expected = `bytes ${start}-${end}/${spec.size}`;
        if (!(response?.status === 206 && range === expected || response?.status === 200 && start === 0 && end === spec.size - 1)) {
          await response?.body?.cancel(); throw Error('分段下载响应无效。');
        }
        let size = start;
        const inspect = new Transform({ transform: (chunk, encoding, callback) => {
          size += chunk.length; this.progress = Math.min(99, Math.round(size / spec.size * 100));
          if (size > end + 1) return callback(Error('模型下载分段大小无效。')); callback(null, chunk);
        } });
        await pipeline(response.body, inspect, createWriteStream(temporary, { flags: 'a' }), { signal: this.controller.signal });
        if (size !== end + 1) throw Error('模型下载分段不完整。'); failures = 0;
      } catch (e) { if (this.controller.signal.aborted || ++failures >= 3) throw e; }
    }
    if (!(await verifyWdFile(temporary, spec))) { unlinkSync(temporary); throw Error('模型完整性校验未通过。'); }
    renameSync(temporary, path);
  }
  async performUpdate() {
    this.phase = 'checking'; this.error = ''; this.controller = new AbortController();
    try {
      const meta = await smallJson(await this.fetch(`https://huggingface.co/api/models/${WD_REPO}?blobs=true`, { signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(30000)]) }));
      if (!/^[a-f0-9]{40}$/.test(meta.sha)) throw Error('版本信息无效。');
      if (meta.sha !== this.manifest.revision || !this.active) {
        this.phase = 'downloading'; const dir = join(this.root, meta.sha); mkdirSync(dir, { recursive: true });
        for (const name of ['model.onnx', 'selected_tags.csv']) {
          const spec = meta.siblings?.find(f => f.rfilename === name);
          if (!spec || !Number.isSafeInteger(spec.size) || spec.size <= 0 || !(spec.lfs?.sha256 || spec.blobId)) throw Error('模型清单无效。');
          await this.download(meta.sha, spec, join(dir, name));
        }
        this.phase = 'validating'; const replacement = await this.loadBundle(meta.sha);
        // Keep the old bundle alive until an in-flight prediction has completed.
        const previous = this.active; this.active = replacement;
        if (previous) (this.prediction ?? Promise.resolve()).finally(() => previous.session.release()).catch(() => {});
        this.manifest = { revision: meta.sha, previous: this.manifest.revision ?? '', checkedAt: this.now(), repo: WD_REPO };
        this.log('WD 二次元标签模型已就绪');
      } else this.manifest.checkedAt = this.now();
      atomicJson(this.file, this.manifest); this.phase = 'ready'; this.progress = 100;
    } catch { this.phase = this.active ? 'ready' : 'error'; this.error = 'WD 更新未完成，已有模型继续使用；稍后可重试。'; this.manifest.checkedAt = this.now(); atomicJson(this.file, this.manifest); }
    return this.status();
  }
  async predict(paths) {
    if (!this.settings.value.wdEnabled || !this.active) return { available: false, candidates: [] };
    const bundle = this.active;
    const work = (async () => {
      const scores = new Float32Array(bundle.labels.length);
      for (const path of paths.slice(0, 3)) {
        const pixels = await wdPixels(path);
        const result = await bundle.session.run({ [bundle.session.inputNames[0]]: new bundle.ort.Tensor('float32', pixels, [1, 448, 448, 3]) });
        const values = result[bundle.session.outputNames[0]].data;
        for (let i = 0; i < scores.length; i++) scores[i] = Math.max(scores[i], values[i]);
      }
      return { available: true, model: WD_REPO, revision: bundle.revision, candidates: rankWd(scores, bundle.labels, this.settings.value.wdGeneralThreshold, this.settings.value.wdCharacterThreshold) };
    })();
    this.prediction = work; try { return await work; } finally { if (this.prediction === work) this.prediction = null; }
  }
  async close() { this.closed = true; clearInterval(this.timer); this.controller?.abort(); await this.updating; await this.prediction?.catch(() => {}); await this.active?.session.release(); }
}
