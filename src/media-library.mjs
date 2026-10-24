import { existsSync, readFileSync, writeFileSync, statSync, renameSync, readdirSync } from 'node:fs';
import { join, resolve, extname } from 'node:path';
import { createHash } from 'node:crypto';
import { atomicJson } from './companion-settings.mjs';
import { prepareRecords } from './record-storage.mjs';
import { inspectImage, MAX_IMAGE_BYTES } from './image-codec.mjs';
import { WdTagger } from './wd-tagger.mjs';
import { ImageLookup } from './image-lookup.mjs';
import { CharacterReferences } from './character-references.mjs';
import { analyzeImage } from './vision-analysis.mjs';
import { isStickerSource, selectImageRefs } from './media-policy.mjs';
export { visionSchema } from './vision-labels.mjs';

export const dragonReference = {
  url: 'https://genderswapai.com/zh-CN/ai-gijinka/gpt',
  description: '用户指定的 ZipZipPipe 版 GPT / ChatGPT 娘：白发、龙角、龙翼与龙尾、白金礼服，也包括同一角色的小龙娘和不同画风、表情、服装变体。不要把单纯白发女孩、其他白龙或黑色 Image 2 龙娘认定为该角色。若有相似特征但无法确定，标 possible。'
};
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const tagsOf = tags => [...new Set((Array.isArray(tags) ? tags : String(tags ?? '').split(/[,，\n]/)).map(t => String(t).trim().slice(0, 30)).filter(Boolean))].slice(0, 20);
export function imageUrlAllowed(raw) {
  try {
    const u = new URL(raw);
    return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password && (!u.port || ['80', '443'].includes(u.port)) &&
      ['qq.com', 'qq.com.cn', 'qpic.cn', 'gtimg.cn', 'qlogo.cn', 'gtimg.com'].some(d => u.hostname === d || u.hostname.endsWith('.' + d));
  } catch { return false; }
}
async function download(raw) {
  let url = raw;
  for (let hop = 0; hop < 4; hop++) {
    if (!imageUrlAllowed(url)) throw new Error('只读取 QQ 图片服务提供的地址。');
    const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(20000) });
    if ([301, 302, 303, 307, 308].includes(response.status)) { await response.body?.cancel(); url = new URL(response.headers.get('location'), url).href; continue; }
    if (!response.ok || Number(response.headers.get('content-length')) > MAX_IMAGE_BYTES) { await response.body?.cancel(); throw new Error('图片下载失败或图片超过 12 MB。'); }
    const chunks = []; let length = 0;
    for await (const chunk of response.body) { length += chunk.length; if (length > MAX_IMAGE_BYTES) throw new Error('图片超过 12 MB。'); chunks.push(chunk); }
    return Buffer.concat(chunks);
  }
  throw new Error('图片地址跳转过多。');
}
export class MediaLibrary {
  constructor(config, settings, codex, { now = Date.now, log = () => {}, fetchImage = download, wd, lookup } = {}) {
    this.config = config; this.settings = settings; this.codex = codex; this.now = now; this.log = log; this.fetchImage = fetchImage;
    this.paths = prepareRecords(config); this.file = join(this.paths.text, 'media-library.json');
    this.wd = wd ?? new WdTagger(config, settings, { now, log }); this.lookup = lookup ?? new ImageLookup(config, settings, { now });
    this.references = new CharacterReferences(this.paths);
    this.state = existsSync(this.file) ? JSON.parse(readFileSync(this.file, 'utf8')) : { items: {}, aliases: {}, pixels: {}, tokens: 0 };
    this.state.sources ??= {}; this.sources = new Map();
    this.imports = new Map(); this.tasks = new Map(); this.started = false; this.closed = false;
    this.chatReaders = 0; this.chatWaiters = new Set();
    for (const item of Object.values(this.state.items)) {
      if (item.status === 'analyzing') item.status = 'pending';
      if (item.status === 'pending' && item.kind !== 'sticker' && !item.analysisRequested) item.status = 'unclassified';
      // Older versions never recorded whether a tag/description was hand-edited.
      if (item.status === 'ready' && !item.analysis && !Object.hasOwn(item, 'legacyProtected')) {
        item.legacyProtected = true; item.manualTags = true; item.manualDescription = true; item.manualOcr = true;
      }
    }
    this.save();
  }
  save() { atomicJson(this.file, this.state); }
  get(id) { return typeof id === 'string' && /^[a-f0-9]{64}$/.test(id) ? this.state.items[id] : undefined; }
  original(item) { return join(this.paths.images, item.kind === 'sticker' ? 'stickers' : 'images', `${item.id}.${item.ext}`); }
  preview(item, index = 0) { return join(this.paths.images, 'previews', `${item.id}-${index}.png`); }
  public(item) { return { id: item.id, kind: item.kind, description: item.description, tags: item.tags, ocr: item.ocr, favorite: item.favorite, dragon: item.dragon, enabled: item.enabled, shared: item.shared, rooms: item.rooms, status: item.status, error: item.error, createdAt: item.createdAt, pages: item.pages, bytes: item.bytes, width: item.width, height: item.height,
    analysis: item.analysis ?? null, manualTags: Boolean(item.manualTags), manualDescription: Boolean(item.manualDescription), manualOcr: Boolean(item.manualOcr), legacyProtected: Boolean(item.legacyProtected), previousAnalysis: Boolean(item.analysisHistory?.length), referenceEntries: this.references.all().filter(r => r.mediaId === item.id) }; }
  summary() {
    const items = Object.values(this.state.items);
    return { total: items.length, ready: items.filter(i => i.status === 'ready').length, pending: items.filter(i => ['pending', 'analyzing'].includes(i.status)).length, tokens: this.state.tokens, imageRoot: this.paths.images, textRoot: this.paths.text, reference: dragonReference.url, wd: this.wd.status(), references: this.references.all().map(({ file, ...r }) => r) };
  }
  list({ q = '', kind = '', favorite = false, offset = 0 } = {}) {
    const all = Object.values(this.state.items).filter(i => (!kind || i.kind === kind) && (!favorite || i.favorite) && (!q || [i.description, ...i.tags].join(' ').toLowerCase().includes(q.toLowerCase())))
      .sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
    return { ...this.summary(), matched: all.length, items: all.slice(offset, offset + 100).map(i => this.public(i)) };
  }
  async import(bytes, { kind = 'auto', tags = [], roomKey, shared = !roomKey, name = '', classify = kind !== 'image', fromChat = false, isCancelled = () => false } = {}) {
    if (!['auto', 'sticker', 'image'].includes(kind)) throw new Error('图片分类无效。');
    if (!Buffer.isBuffer(bytes) || bytes.length > MAX_IMAGE_BYTES) throw new Error('图片超过 12 MB。');
    const digest = hash(bytes);
    const existing = this.get(this.state.aliases[digest] ?? digest);
    const reuse = item => {
      if (!isCancelled() && !this.closed) {
        this.addSource(item, roomKey, shared, tags);
        if (classify && item.status === 'unclassified') {
          if (kind === 'sticker' && !item.manualKind) this.changeKind(item, 'sticker');
          item.analysisRequested = !fromChat; item.status = 'pending'; this.save(); this.enqueue(item);
        }
      }
      return item;
    };
    if (existing) return reuse(existing);
    if (this.imports.has(digest)) return reuse(await this.imports.get(digest));
    const work = (async () => {
      const meta = await inspectImage(bytes);
      if (isCancelled() || this.closed) throw new Error('图片处理已取消。');
      const duplicate = this.get(this.state.pixels[meta.pixelHash]);
      if (duplicate) { this.state.aliases[digest] = duplicate.id; return reuse(duplicate); }
      const item = { id: digest, ext: meta.ext, mime: meta.mime, width: meta.width, height: meta.height, pages: meta.pages, frameCount: meta.previews.length, bytes: bytes.length,
        kind: kind === 'sticker' ? 'sticker' : 'image', manualKind: kind !== 'auto' && !fromChat, description: '', ocr: '', tags: tagsOf(tags), status: classify ? 'pending' : 'unclassified', analysisRequested: classify && !fromChat, dragon: 'no', favorite: false,
        enabled: shared || kind === 'sticker', shared, rooms: roomKey ? [roomKey] : [], sourceName: String(name).slice(0, 160), createdAt: this.now(), lastUsed: {}, seedTags: tagsOf(tags) };
      if (!existsSync(this.original(item))) writeFileSync(this.original(item), bytes, { flag: 'wx' });
      else if (hash(readFileSync(this.original(item))) !== digest) throw new Error('同名图片内容冲突。');
      meta.previews.forEach((preview, i) => writeFileSync(this.preview(item, i), preview));
      this.state.items[digest] = item; this.state.aliases[digest] = digest; this.state.pixels[meta.pixelHash] = digest; this.save();
      if (classify) this.enqueue(item); return item;
    })();
    this.imports.set(digest, work);
    try { return await work; } finally { this.imports.delete(digest); }
  }
  addSource(item, roomKey, shared, tags) {
    if (roomKey && !item.rooms.includes(roomKey)) item.rooms.push(roomKey);
    if (shared) item.shared = true;
    if (!item.manualTags) { item.seedTags = tagsOf([...(item.seedTags ?? []), ...tagsOf(tags)]); item.tags = tagsOf([...item.tags, ...tagsOf(tags)]); } this.save();
  }
  register(parts) {
    return parts.filter(p => p.type === 'image').slice(0, 50).map(p => {
      const data = p.data ?? {};
      let identity = /^[a-zA-Z0-9_-]{16,256}(?:\.(?:png|jpe?g|gif|webp))?$/i.test(String(data.file ?? '')) ? String(data.file) : '';
      if (!identity) { try { const u = new URL(data.url); identity = u.origin + u.pathname + (u.searchParams.get('fileid') ?? ''); } catch { return null; } }
      const key = hash(Buffer.from(`${isStickerSource(data) ? 'sticker' : 'image'}:${identity}`)); this.sources.set(key, { file: data.file, url: data.url, sub_type: data.sub_type, emoji_id: data.emoji_id });
      while (this.sources.size > 2000) this.sources.delete(this.sources.keys().next().value);
      return key;
    }).filter(Boolean);
  }
  stickerRef(ref) { return this.sources.has(ref) ? isStickerSource(this.sources.get(ref)) : this.get(this.state.sources[ref])?.kind === 'sticker'; }
  beginChat() {
    this.chatReaders++; let released = false;
    return () => {
      if (released) return; released = true; this.chatReaders--;
      if (!this.chatReaders) { for (const done of this.chatWaiters) done(); this.chatWaiters.clear(); if (!this.closed) setImmediate(() => this.pump()); }
    };
  }
  async waitForChat() { if (this.chatReaders && !this.closed) await new Promise(resolve => this.chatWaiters.add(resolve)); }
  async prepareRecent(messages, roomKey, isCancelled = () => false, context = messages) {
    const plan = selectImageRefs(messages, context, ref => this.stickerRef(ref));
    const refs = this.settings.value.visionEnabled ? plan.ordered : [];
    const fresh = [];
    for (const ref of refs) {
      const item = this.get(this.state.sources[ref]);
      if (item) { if (!isCancelled()) this.addSource(item, roomKey, false, []); continue; }
      if (this.sources.has(ref) && fresh.length < 5) fresh.push(ref);
    }
    await Promise.all(fresh.map(async ref => {
      try {
        const item = await this.capture(this.sources.get(ref), roomKey, { isCancelled });
        if (item && !isCancelled()) { this.state.sources[ref] = item.id; this.save(); }
      } catch { this.log('一张聊天图片暂时无法读取'); }
    }));
    // Chat receives actual image inputs immediately; tagging has its own queue.
    const imagePaths = [], attachments = [], attached = new Set();
    if (!isCancelled()) for (const ref of refs) {
      const item = this.get(this.state.sources[ref]);
      if (!item || attached.has(item.id) || attached.size >= 5 || (item.status === 'ready' && !plan.explicit.has(ref))) continue;
      attached.add(item.id);
      const firstInput = imagePaths.length + 1;
      for (let i = 0; i < item.frameCount; i++) if (existsSync(this.preview(item, i))) imagePaths.push(this.preview(item, i));
      if (imagePaths.length >= firstInput) attachments.push({ id: item.id, firstInput, frames: imagePaths.length - firstInput + 1,
        messageIds: context.filter(m => m.imageRefs?.includes(ref) || m.quotedImageRefs?.includes(ref)).map(m => m.id), explicitlyRequested: plan.explicit.has(ref) });
    }
    return { imagePaths, attachments, allowedRefs: new Set(refs) };
  }
  describeMessage(message, prepared = {}) {
    const permitted = (message.imageRefs ?? []).filter(ref => prepared.allowedRefs ? prepared.allowedRefs.has(ref) : this.stickerRef(ref));
    const ids = permitted.map(ref => this.state.sources[ref]).filter(Boolean);
    const { imageRefs, quotedImageRefs, userText, ...rest } = message;
    // Remove the old catch-all placeholder from persisted history after upgrading.
    rest.text = String(rest.text ?? '').replaceAll('[图片/表情，内容见 images 识图字段]', permitted.length ? '[表情或指定图片]' : '');
    if (rest.quote?.text) rest.quote = { ...rest.quote, text: rest.quote.text.replaceAll('[图片/表情，内容见 images 识图字段]', '') };
    return { ...rest, images: this.describe(ids), unreadImages: Math.max(0, permitted.length - ids.length) };
  }
  async capture(data, roomKey, { isCancelled = () => false } = {}) {
    if (isCancelled()) return null;
    let bytes;
    if (data.url && imageUrlAllowed(data.url)) {
      try { bytes = await this.fetchImage(data.url); } catch { /* Expired URLs may still be available in NapCat's cache. */ }
    }
    if (!bytes) {
      // Never pass user-supplied file paths or URLs to NapCat's general file reader.
      const file = String(data.file ?? '');
      if (!/^[a-zA-Z0-9_-]{16,256}(?:\.(?:png|jpe?g|gif|webp))?$/i.test(file)) throw new Error('图片缺少可读取的 QQ 文件标识。');
      const result = await this.qq.call('get_image', { file });
      if (isCancelled()) return null;
      if (result.base64) {
        if (result.base64.length > Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 4) throw new Error('图片超过 12 MB。');
        bytes = Buffer.from(result.base64, 'base64');
      } else if (imageUrlAllowed(result.url)) bytes = await this.fetchImage(result.url);
      else if (typeof result.file === 'string' && /^[a-z]:[\\/]/i.test(result.file)) {
        const filePath = resolve(result.file);
        if (statSync(filePath).size > MAX_IMAGE_BYTES) throw new Error('图片超过 12 MB。');
        bytes = readFileSync(filePath);
      } else throw new Error('QQ 暂时无法提供图片内容。');
    }
    if (isCancelled()) return null;
    const sticker = isStickerSource(data);
    return this.import(bytes, { kind: sticker ? 'sticker' : 'image', classify: sticker, fromChat: true, roomKey, shared: false, isCancelled });
  }
  start(qq = this.qq) { if (this.started) return; this.qq = qq; this.started = true; this.wd.start(); for (const item of Object.values(this.state.items)) if (item.status === 'pending') this.enqueue(item); this.pump(); }
  enqueue(item) {
    if (item.status !== 'pending' || (item.kind !== 'sticker' && !item.analysisRequested) || this.tasks.has(item.id)) return;
    let finish; const done = new Promise(resolve => { finish = resolve; });
    this.tasks.set(item.id, { done, finish }); this.pump();
  }
  pump() {
    if (this.closed || !this.started || this.working || this.chatReaders || !this.settings.value.visionEnabled) return;
    const next = [...this.tasks.keys()].find(id => this.get(id)?.status === 'pending');
    if (!next) return;
    this.onBackgroundStart?.();
    this.working = next;
    void this.analyze(this.get(next)).catch(() => {
      this.log('图片记录写入失败，请检查图片与文字目录是否可用');
    }).finally(() => {
      this.tasks.get(next)?.finish(); this.tasks.delete(next); this.working = null;
      if (!this.closed) setImmediate(() => this.pump());
    });
  }
  async analyze(item) {
    item.status = 'analyzing'; item.error = ''; this.save();
    try {
      const result = await analyzeImage(this, item);
      if (this.closed) { item.status = 'pending'; return; }
      if (!item.manualKind) this.changeKind(item, result.kind);
      item.analysis = result;
      if (!item.manualDescription) item.description = result.description;
      if (!item.manualOcr) item.ocr = result.ocr;
      if (!item.manualTags) item.tags = tagsOf([...(item.seedTags ?? []), ...result.autoTags]); item.dragon = result.dragon;
      if (result.dragon !== 'no') { if (!item.manualFavorite) item.favorite = true; if (!item.manualEnabled && result.dragon === 'yes') item.enabled = true; }
      else if (!Object.hasOwn(item, 'manualEnabled')) item.enabled ||= item.kind === 'sticker';
      item.status = 'ready'; item.analyzedAt = this.now();
      this.log(result.dragon === 'yes' ? '识图完成，已核实 GPT 龙娘并收藏' : result.dragon === 'possible' ? '疑似 GPT 龙娘已保留，身份待核实' : '识图完成，已保存分类标签与核验依据');
    } catch { item.status = this.closed ? 'pending' : item.analysis || item.analysisHistory?.at(-1)?.status === 'ready' ? 'ready' : 'failed'; item.error = this.closed ? '' : '识图未完成，已有标签和原图已保留，可重试。'; this.log('一张图片识别未完成，原图已保留'); }
    finally { this.analysisRoom = null; this.save(); }
  }
  async waitFor(ids, timeout = 60000) {
    const waiting = ids.map(id => this.tasks.get(id)?.done).filter(Boolean);
    if (!waiting.length || !this.settings.value.visionEnabled) return;
    let timer;
    try { await Promise.race([Promise.all(waiting), new Promise(resolve => { timer = setTimeout(resolve, timeout); })]); } finally { clearTimeout(timer); }
  }
  describe(ids) {
    return ids.map(id => this.get(id)).filter(Boolean).map(i => ({ id: i.id, kind: i.kind, status: i.status, description: i.description, tags: i.tags, textInImage: i.ocr, dragon: i.dragon,
      labelSource: i.legacyProtected ? '旧版内容保留，未经新流程复核' : i.manualTags ? '用户修正优先' : i.analysis ? '已分类；未确认项不可当事实' : i.status === 'unclassified' ? '仅按请求读图，不自动整理标签' : '后台标签待完成；聊天以实际附件为准',
      usageSuggestions: i.manualTags || i.manualDescription || i.manualOcr ? [] : i.analysis?.usage ?? [], uncertain: i.analysis?.uncertain ?? [] }));
  }
  eligible(item, roomKey) {
    return item?.status === 'ready' && item.enabled && (item.shared || item.rooms.includes(roomKey)) &&
      (!item.lastUsed[roomKey] || this.now() - item.lastUsed[roomKey] >= this.settings.value.mediaCooldownMinutes * 60000) && existsSync(this.original(item));
  }
  candidates(roomKey, context = '') {
    const pool = Object.values(this.state.items).filter(i => this.eligible(i, roomKey));
    const score = i => i.tags.reduce((n, tag) => n + (context.includes(tag) ? 4 : 0), 0) + Number(i.favorite);
    return pool.sort((a, b) => score(b) - score(a) || b.createdAt - a.createdAt).slice(0, 60).map(i => ({ id: i.id, kind: i.kind, description: i.description.slice(0, 300), tags: i.tags,
      textInImage: i.ocr, usageSuggestions: i.manualTags || i.manualDescription || i.manualOcr ? [] : (i.analysis?.usage ?? []).filter(t => t.confidence !== 'low'),
      labelSource: i.legacyProtected ? '旧版内容保留，未经新流程复核' : i.manualTags ? '用户修正优先' : i.analysis ? '分类标签' : '旧版待核验' }));
  }
  markUsed(item, roomKey) { item.lastUsed[roomKey] = this.now(); this.save(); }
  changeKind(item, kind) {
    if (item.kind === kind) return;
    const source = this.original(item), previous = item.kind;
    item.kind = kind;
    try { renameSync(source, this.original(item)); } catch (error) { item.kind = previous; throw error; }
  }
  update(id, patch) {
    const item = this.get(id); if (!item) throw new Error('图片不存在。');
    if (patch.kind && !['sticker', 'image'].includes(patch.kind)) throw new Error('图片分类无效。');
    for (const key of ['enabled', 'favorite', 'shared']) if (Object.hasOwn(patch, key) && typeof patch[key] !== 'boolean') throw new Error('图片开关格式无效。');
    if (patch.description !== undefined && (typeof patch.description !== 'string' || patch.description.length > 1200)) throw new Error('图片说明最多 1200 字。');
    if (patch.ocr !== undefined && (typeof patch.ocr !== 'string' || patch.ocr.length > 4000)) throw new Error('图片文字最多 4000 字。');
    if (patch.tags !== undefined && (!Array.isArray(patch.tags) || patch.tags.some(t => typeof t !== 'string'))) throw new Error('标签格式无效。');
    if (patch.kind) { this.changeKind(item, patch.kind); item.manualKind = true; }
    for (const key of ['enabled', 'favorite', 'shared', 'description']) if (Object.hasOwn(patch, key)) item[key] = patch[key];
    if (Object.hasOwn(patch, 'enabled')) item.manualEnabled = true;
    if (Object.hasOwn(patch, 'favorite')) item.manualFavorite = true;
    if (Object.hasOwn(patch, 'description')) item.manualDescription = true;
    if (Object.hasOwn(patch, 'ocr')) { item.ocr = patch.ocr; item.manualOcr = true; }
    if (patch.tags) { item.tags = tagsOf(patch.tags); item.manualTags = true; }
    this.save(); return this.public(item);
  }
  retry(id) {
    const item = this.get(id); if (!item) throw new Error('图片不存在。');
    if (item.status === 'failed') { item.analysisRequested = true; item.status = 'pending'; item.error = ''; this.save(); this.enqueue(item); }
    return this.public(item);
  }
  reanalyze(id) {
    const item = this.get(id); if (!item) throw new Error('图片不存在。');
    if (this.tasks.has(id) || ['analyzing', 'pending'].includes(item.status)) return this.public(item);
    item.analysisHistory = [...(item.analysisHistory ?? []), { at: this.now(), status: item.status, analysis: item.analysis ?? null, tags: item.tags, description: item.description, ocr: item.ocr }].slice(-3);
    item.analysisRequested = true; item.status = 'pending'; item.error = ''; this.save(); this.enqueue(item); return this.public(item);
  }
  addReference(id, patch) { const item = this.get(id); if (!item) throw new Error('图片不存在。'); return this.references.add(item, this.preview(item), patch); }
  useAutomatic(id) {
    const item = this.get(id); if (!item?.analysis || item.status !== 'ready') throw new Error('请先完成重新识别，再采用自动结果。');
    item.analysisHistory = [...(item.analysisHistory ?? []), { at: this.now(), status: item.status, analysis: item.analysis, tags: item.tags, description: item.description, ocr: item.ocr }].slice(-3);
    item.manualTags = false; item.manualDescription = false; item.manualOcr = false; item.legacyProtected = false;
    item.seedTags = []; item.tags = tagsOf(item.analysis.autoTags); item.description = item.analysis.description; item.ocr = item.analysis.ocr;
    this.save(); return this.public(item);
  }
  async scan() {
    let added = 0, skipped = 0;
    for (const [folder, kind] of [['', 'auto'], ['stickers', 'sticker'], ['images', 'image']]) {
      for (const file of readdirSync(join(this.paths.images, folder), { withFileTypes: true })) {
        if (!file.isFile() || !['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(extname(file.name).toLowerCase())) continue;
        const path = join(this.paths.images, folder, file.name);
        if (/^[a-f0-9]{64}\./.test(file.name) && this.get(file.name.split('.')[0])) continue;
        try { if (statSync(path).size > MAX_IMAGE_BYTES) { skipped++; continue; } const before = Object.keys(this.state.items).length; await this.import(readFileSync(path), { kind, name: file.name }); added += Object.keys(this.state.items).length - before; } catch { skipped++; }
      }
    }
    return { added, skipped };
  }
  async close() {
    this.closed = true;
    for (const done of this.chatWaiters) done(); this.chatWaiters.clear();
    if (this.analysisRoom?.threadId) await this.codex.interrupt(this.analysisRoom.threadId).catch(() => {});
    for (const task of this.tasks.values()) task.finish();
    await this.wd.close();
  }
}
