import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { Settings } from '../src/companion-settings.mjs';
import { MediaLibrary } from '../src/media-library.mjs';
import { imageProcessor } from '../src/image-codec.mjs';
import { normalizeVision, derivedTags, visionPrompt } from '../src/vision-labels.mjs';
import { WdTagger, parseTagCsv, rankWd, wdPixels, verifyWdFile } from '../src/wd-tagger.mjs';
import { ImageLookup } from '../src/image-lookup.mjs';
import { vision, visionValue } from './vision-fixture.mjs';

const pause = ms => new Promise(r => setTimeout(r, ms));
const label = (text, confidence = 'high') => ({ text, confidence, evidence: '明确的画面依据：' + text });
const png = () => imageProcessor()({ create: { width: 40, height: 24, channels: 4, background: '#ff0000' } }).png().toBuffer();
function fixture(t) {
  mkdirSync(resolve('work'), { recursive: true }); const runtime = mkdtempSync(join(resolve('work'), 'quality-test-'));
  const config = { runtime, recordRoot: join(runtime, 'records'), textRoot: join(runtime, 'records', 'txt') };
  const settings = new Settings(runtime); settings.update({ wdEnabled: false, reverseSearchEnabled: false });
  const calls = [], codex = { interrupt: async () => {}, ask: async (...args) => { calls.push(args); return vision(); } };
  const media = new MediaLibrary(config, settings, codex); media.start();
  t.after(async () => { await media.close(); for (let i = 0; i < 100 && media.working; i++) await pause(5); rmSync(runtime, { recursive: true, force: true }); });
  return { config, settings, codex, media, calls };
}
test('precision favors evidence, separates usage, and never treats WD scores as a guarantee', () => {
  const v = visionValue({ facts: [label('双马尾'), label('星星眼', 'low'), label('初音未来')], emotions: [label('开心', 'medium')], usage: [label('撒娇')],
    characters: [{ name: '初音未来', work: '', confidence: 'high', evidence: '发饰与服装组合', wdName: 'hatsune_miku' }] });
  const unknown = normalizeVision(v); assert.deepEqual(derivedTags(unknown), ['双马尾']);
  const supported = normalizeVision(v, { candidates: [{ name: 'hatsune_miku', category: 4, score: .92 }] });
  assert.deepEqual(derivedTags(supported), ['双马尾', '初音未来']); assert.equal(supported.usage[0].text, '撒娇');
  assert.deepEqual(derivedTags(normalizeVision(visionValue({ tags: [] }))), []);
  assert.throws(() => normalizeVision({ ...v, facts: [{ text: '星星眼', confidence: 'high' }] }));
  assert.equal(visionPrompt({}, []).characterReference, undefined);
});
test('manual edits made during recognition and before reanalysis survive without old usage leaking to chat', async t => {
  const f = fixture(t); let finish;
  f.codex.ask = () => new Promise(r => { finish = r; });
  const item = await f.media.import(await png());
  while (!finish) await pause(1);
  f.media.update(item.id, { tags: ['淡定'], description: '托腮看着前方', ocr: '知道了' });
  finish(vision({ tags: ['开心'], usage: [label('嘲讽')] })); await f.media.waitFor([item.id]);
  f.codex.ask = async () => vision({ tags: ['星星眼'], description: '猜错描述', ocr: '猜错文字', usage: [label('撒娇')] });
  f.media.reanalyze(item.id); await f.media.waitFor([item.id]);
  assert.deepEqual(item.tags, ['淡定']); assert.equal(item.description, '托腮看着前方'); assert.equal(item.ocr, '知道了');
  assert.deepEqual(f.media.candidates('group:11111')[0].usageSuggestions, []);
  assert.equal(item.analysisHistory.length, 1); assert.equal(item.analysis.autoTags[0], '星星眼');
});
test('explicit reanalysis replaces automatic mistakes; ordinary duplicate imports keep the cache', async t => {
  const f = fixture(t); f.codex.ask = async () => vision({ tags: ['星星眼'] }); const bytes = await png(), item = await f.media.import(bytes); await f.media.waitFor([item.id]);
  f.codex.ask = async () => vision({ tags: ['圆眼'] });
  await f.media.import(bytes); assert.deepEqual(item.tags, ['星星眼']);
  f.media.reanalyze(item.id); await f.media.waitFor([item.id]); assert.deepEqual(item.tags, ['圆眼']);
  f.codex.ask = async () => { throw Error('offline'); };
  f.media.reanalyze(item.id); await f.media.waitFor([item.id]); assert.equal(item.status, 'ready'); assert.deepEqual(item.tags, ['圆眼']);
});
test('references are only attached to matching candidates; negative evidence blocks character confirmation', async t => {
  const f = fixture(t), item = await f.media.import(await png()); await f.media.waitFor([item.id]);
  writeFileSync(join(f.media.paths.images, 'references', 'gpt.png'), await png());
  assert.deepEqual(f.media.references.select(normalizeVision(visionValue())), []);
  f.media.addReference(item.id, { character: 'GPT龙娘', work: '', referenceKind: 'negative' });
  let passes = 0;
  f.codex.ask = async (room, prompt, timeout, options) => {
    passes++; const p = JSON.parse(prompt);
    if (options.outputSchema.properties.matches) { assert.equal(p.referenceImages.length, 2); return JSON.stringify({ matches: [{ name: 'GPT龙娘', verdict: 'no', evidence: '目标与反例一致，缺少该角色特有设计' }] }); }
    assert.equal(options.imagePaths.length, 1); return vision({ dragon: 'possible', characters: [{ name: 'GPT龙娘', work: '', confidence: 'high', evidence: '白发龙角', wdName: '' }] });
  };
  f.media.reanalyze(item.id); await f.media.waitFor([item.id]); assert.equal(passes, 2); assert.equal(item.dragon, 'no'); assert.ok(!item.tags.includes('GPT龙娘'));
  assert.equal(item.analysis.characters[0].source, 'reference-rejected');
});
test('reference entries persist locally and can be removed without deleting the original', async t => {
  const f = fixture(t), item = await f.media.import(await png()); await f.media.waitFor([item.id]);
  const r = f.media.addReference(item.id, { character: '初音未来', work: 'VOCALOID', referenceKind: 'positive' });
  assert.equal(JSON.parse(readFileSync(join(f.config.textRoot, 'character-references.json')))[0].id, r.id);
  f.media.references.remove(r.id); assert.equal(f.media.references.catalog().length, 0); assert.ok(readFileSync(f.media.original(item)).length);
  assert.throws(() => f.media.addReference(item.id, { character: '', referenceKind: 'positive' }));
});
test('WD input has white padding and BGR float pixels; ratings do not become chat tags', async t => {
  const f = fixture(t), path = join(f.config.runtime, 'pixels.png'); writeFileSync(path, await png());
  const p = await wdPixels(path, 40); assert.deepEqual([...p.slice(0, 3)], [255, 255, 255]);
  const center = (20 * 40 + 20) * 3; assert.deepEqual([...p.slice(center, center + 3)], [0, 0, 255]);
  const labels = parseTagCsv('tag_id,name,category\r\n1,"a,b",0\r\n2,miku,4\r\n3,general,9\r\n');
  assert.equal(labels[0].name, 'a,b');
  assert.deepEqual(rankWd([.7, .89, .99], labels, .6, .9).map(t => t.name), ['a,b']);
});
test('WD range downloads check offsets and digest, resume partial files, and reuse verified files', async t => {
  const f = fixture(t), bytes = Buffer.from('0123456789abcdef'), sha = createHash('sha256').update(bytes).digest('hex');
  const spec = { rfilename: 'model.onnx', size: bytes.length, lfs: { sha256: sha } }, path = join(f.config.runtime, 'small.onnx');
  writeFileSync(path + '.part', bytes.subarray(0, 5)); let calls = 0;
  const wd = new WdTagger(f.config, f.settings, { fetcher: async (url, opts) => { calls++; assert.equal(opts.headers.Range, 'bytes=5-15'); return new Response(bytes.subarray(5), { status: 206, headers: { 'content-range': 'bytes 5-15/16' } }); } });
  wd.controller = new AbortController(); await wd.download('a'.repeat(40), spec, path); assert.equal(await verifyWdFile(path, spec), true);
  await wd.download('a'.repeat(40), spec, path); assert.equal(calls, 1);
  writeFileSync(path, 'bad'); wd.fetch = async () => new Response(bytes, { status: 206, headers: { 'content-range': 'bytes 3-18/16' } });
  await assert.rejects(wd.download('a'.repeat(40), spec, path)); await wd.close();
});
test('model update validation failure leaves the current working model selected', async t => {
  const f = fixture(t), wd = new WdTagger(f.config, f.settings, { fetcher: async () => Response.json({ sha: 'b'.repeat(40), siblings: ['model.onnx', 'selected_tags.csv'].map(rfilename => ({ rfilename, size: 10, blobId: 'c'.repeat(40) })) }) });
  let released = false; wd.active = { revision: 'a'.repeat(40), session: { release: async () => { released = true; } } }; wd.manifest = { revision: 'a'.repeat(40) };
  wd.download = async () => {}; wd.loadBundle = async () => { throw Error('incompatible'); };
  await wd.update(true); assert.equal(wd.manifest.revision, 'a'.repeat(40)); assert.equal(wd.status().ready, true); assert.equal(released, false);
  await wd.close();
});
test('reverse lookup skips photos and missing keys, limits requests, and cannot fetch arbitrary previews', async t => {
  const f = fixture(t); f.settings.update({ reverseSearchEnabled: true, reverseSearchHourlyLimit: 1 }); let calls = 0;
  const lookup = new ImageLookup(f.config, f.settings, { fetcher: async () => { calls++; return Response.json({ error: '', result: [{ anilist: { id: 123, title: { native: '测试动画' } }, similarity: .95, image: 'https://api.trace.moe/image/example' }] }); } });
  const path = join(f.config.runtime, 'lookup.png'); writeFileSync(path, await png());
  assert.equal((await lookup.search(path, 'photo')).status, 'skipped');
  assert.equal((await lookup.search(path, 'anime_art')).status, 'key_required'); assert.equal(calls, 0);
  const r = await lookup.search(path, 'anime_screenshot'); assert.equal(r.sources[0].verified, false); assert.equal(r.sources[0].url, 'https://anilist.co/anime/123');
  assert.equal((await lookup.search(path, 'anime_screenshot')).status, 'limited'); assert.equal(calls, 1);
  await assert.rejects(lookup.thumbnail({ thumbnail: 'https://127.0.0.1/private' }));
});
test('API secrets never appear in public settings and invalid thresholds are rejected atomically', t => {
  const f = fixture(t); f.settings.update({ sauceNaoKey: 'test-secret' });
  assert.equal(f.settings.public().sauceNaoConfigured, true); assert.ok(!JSON.stringify(f.settings.public()).includes('test-secret'));
  assert.throws(() => f.settings.update({ wdGeneralThreshold: .01 })); assert.equal(f.settings.value.wdGeneralThreshold, .6);
});
test('legacy tags are protected because old versions did not record edits; adoption is explicit and archived', async t => {
  const f = fixture(t), item = await f.media.import(await png()); await f.media.waitFor([item.id]);
  delete item.analysis; delete item.manualTags; delete item.manualDescription; delete item.manualOcr;
  item.tags = ['旧版人工纠正']; item.description = '旧版手改描述'; f.media.save(); await f.media.close();
  const restored = new MediaLibrary(f.config, f.settings, f.codex); restored.start();
  try {
    const old = restored.get(item.id); assert.equal(old.legacyProtected, true);
    assert.match(restored.describe([old.id])[0].labelSource, /旧版.*未经/);
    restored.reanalyze(old.id); await restored.waitFor([old.id]); assert.deepEqual(old.tags, ['旧版人工纠正']);
    restored.useAutomatic(old.id); assert.deepEqual(old.tags, ['开心', '赞同']); assert.equal(old.manualTags, false);
    assert.deepEqual(old.analysisHistory.at(-1).tags, ['旧版人工纠正']);
  } finally { await restored.close(); }
});
test('a high-scoring search candidate cannot confirm identity until its actual image matches', async t => {
  const f = fixture(t); let sameImage = false;
  f.media.lookup = { search: async () => ({ status: 'searched', sources: [{ provider: 'SauceNAO', similarity: .99, title: '例图', characters: 'hatsune_miku', url: 'https://example.org/source', thumbnail: 'https://saucenao.com/preview', verified: false }] }), thumbnail: png };
  f.codex.ask = async (room, prompt, timeout, options) => options.outputSchema.properties.sameImage ? JSON.stringify({ sameImage, evidence: sameImage ? '角色姿态与构图完全一致' : '只有发色类似', characters: [{ sourceName: 'hatsune_miku', name: '初音未来' }] }) : vision({ tags: ['双马尾'] });
  const item = await f.media.import(await png()); await f.media.waitFor([item.id]); assert.deepEqual(item.tags, ['双马尾']);
  sameImage = true; f.media.reanalyze(item.id); await f.media.waitFor([item.id]); assert.ok(item.tags.includes('初音未来')); assert.equal(item.analysis.lookup.sources[0].verified, true);
});
test('a negative-only reference can reject a WD-supported character', async t => {
  const f = fixture(t), item = await f.media.import(await png()); await f.media.waitFor([item.id]);
  f.media.addReference(item.id, { character: '初音未来', referenceKind: 'negative' });
  f.media.wd.predict = async () => ({ available: true, candidates: [{ category: 4, name: 'hatsune_miku', score: .99 }] });
  f.codex.ask = async (room, prompt, timeout, options) => options.outputSchema.properties.matches ? JSON.stringify({ matches: [{ name: '初音未来', verdict: 'no', evidence: '与用户反例相同' }] }) :
    vision({ characters: [{ name: '初音未来', work: '', confidence: 'high', evidence: '青色双马尾', wdName: 'hatsune_miku' }] });
  f.media.reanalyze(item.id); await f.media.waitFor([item.id]); assert.ok(!item.tags.includes('初音未来')); assert.equal(item.analysis.characters[0].confirmed, false);
});
