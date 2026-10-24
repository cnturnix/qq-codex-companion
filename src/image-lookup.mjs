import { readFileSync } from 'node:fs';
import { imageProcessor } from './image-codec.mjs';
import { mediaFetch, smallJson } from './media-network.mjs';

export function safeSource(raw) {
  try { const u = new URL(raw); return u.protocol === 'https:' && !u.username && !u.password ? u.href.slice(0, 1000) : ''; } catch { return ''; }
}
export class ImageLookup {
  constructor(config, settings, { fetcher = mediaFetch(config.codexProxy), now = Date.now } = {}) { this.fetch = fetcher; this.settings = settings; this.now = now; this.requests = []; }
  async search(path, contentType) {
    if (!this.settings.value.reverseSearchEnabled) return { status: 'disabled', sources: [] };
    if (!['anime_art', 'anime_screenshot'].includes(contentType)) return { status: 'skipped', sources: [] };
    const sauce = contentType === 'anime_art';
    if (sauce && !this.settings.value.sauceNaoKey) return { status: 'key_required', sources: [] };
    this.requests = this.requests.filter(t => this.now() - t < 3600000);
    if (this.requests.length >= this.settings.value.reverseSearchHourlyLimit) return { status: 'limited', sources: [] };
    this.requests.push(this.now());
    try {
      const bytes = readFileSync(path); let response;
      if (sauce) {
        const form = new FormData(); form.set('file', new Blob([bytes], { type: 'image/png' }), 'image.png');
        form.set('api_key', this.settings.value.sauceNaoKey); form.set('output_type', '2'); form.set('numres', '3'); form.set('db', '999');
        const req = new Request('https://saucenao.com/search.php', { method: 'POST', body: form });
        response = await this.fetch(req.url, { method: 'POST', headers: { 'Content-Type': req.headers.get('content-type') }, body: Buffer.from(await req.arrayBuffer()), signal: AbortSignal.timeout(18000) });
      } else response = await this.fetch('https://api.trace.moe/search?anilistInfo', { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: bytes, signal: AbortSignal.timeout(18000) });
      const data = await smallJson(response);
      if (sauce && Number(data.header?.status) < 0 || !sauce && data.error) return { status: 'failed', sources: [] };
      const sources = sauce ? (data.results ?? []).slice(0, 3).map(r => ({ provider: 'SauceNAO', similarity: Number(r.header?.similarity) / 100,
        title: String(r.data?.title ?? r.data?.source ?? '').slice(0, 180), characters: String(r.data?.characters ?? '').slice(0, 180),
        url: safeSource(r.data?.ext_urls?.[0]), thumbnail: safeSource(r.header?.thumbnail), verified: false })) :
        (data.result ?? []).slice(0, 3).map(r => ({ provider: 'trace.moe', similarity: Number(r.similarity), title: String(r.anilist?.title?.native ?? r.anilist?.title?.romaji ?? r.filename ?? '').slice(0, 180),
          characters: '', url: /^\d+$/.test(String(r.anilist?.id ?? r.anilist)) ? 'https://anilist.co/anime/' + (r.anilist?.id ?? r.anilist) : '', thumbnail: safeSource(r.image), verified: false }));
      return { status: 'searched', at: this.now(), sources: sources.filter(s => s.url && Number.isFinite(s.similarity) && s.similarity >= .8 && s.similarity <= 1) };
    } catch { return { status: 'failed', sources: [] }; }
  }
  async thumbnail(source) {
    const url = new URL(source.thumbnail), host = url.hostname;
    // Only search-provider previews; never fetch arbitrary URLs from an indexed page.
    if (!(host === 'saucenao.com' || host.endsWith('.saucenao.com') || host === 'trace.moe' || host.endsWith('.trace.moe'))) throw Error('检索预览地址无效。');
    const response = await this.fetch(url, { signal: AbortSignal.timeout(12000) });
    if (!response.ok) { await response.body?.cancel(); throw Error('检索预览不可用。'); }
    const chunks = []; let size = 0;
    for await (const chunk of response.body) { size += chunk.length; if (size > 4 * 1024 * 1024) throw Error('检索预览过大。'); chunks.push(chunk); }
    return imageProcessor()(Buffer.concat(chunks), { limitInputPixels: 16000000 }).resize(1024, 1024, { fit: 'inside', withoutEnlargement: true }).png().toBuffer();
  }
}
