import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { Settings } from '../src/companion-settings.mjs';
import { MediaLibrary, imageUrlAllowed } from '../src/media-library.mjs';
import { imageProcessor, inspectImage } from '../src/image-codec.mjs';
import { Companion } from '../src/companion.mjs';
import { createConsole } from '../src/console-server.mjs';
import { OneBotClient } from '../src/onebot.mjs';
import { CodexClient } from '../src/codex.mjs';
import { prepareRecords } from '../src/record-storage.mjs';
import { vision } from './vision-fixture.mjs';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const pic = (r = 255) => imageProcessor()({ create: { width: 40, height: 24, channels: 4, background: { r, g: 90, b: 30, alpha: 1 } } }).png().toBuffer();
function fixture(t, patch = {}) {
  mkdirSync(resolve('work'), { recursive: true });
  const runtime = mkdtempSync(join(resolve('work'), 'media-test-'));
  const config = { runtime, recordRoot: join(runtime, 'records'), textRoot: join(runtime, 'records', 'txt'), model: 'test-model', effort: 'high' };
  const settings = new Settings(runtime); settings.update({ mode: 'chat', allowedGroups: ['11111', '22222'], mediaReplyChance: 100, wdEnabled: false, reverseSearchEnabled: false, ...patch });
  const calls = [], sent = []; let time = 1_000_000, reply;
  const codex = { ready: true, interrupt: async () => {}, ask: async (room, prompt, timeout, options) => {
    calls.push({ prompt: JSON.parse(prompt), options }); room.threadId = 'test-thread';
    if (!options.outputSchema.properties.action) return vision();
    return JSON.stringify(reply ?? { action: 'reply', interest: 'normal', messages: ['哈哈', '就是这样'], mediaId: JSON.parse(prompt).availableMedia[0]?.id ?? '', memory: '', glossary: [] });
  } };
  const media = new MediaLibrary(config, settings, codex, { now: () => time });
  const qq = { identity: { id: '99999' }, connected: true, status: () => ({ connected: true }),
    call: async () => ({ messages: [] }),
    send: async (...args) => { sent.push({ type: 'text', args }); return { message_id: 'sent-' + sent.length }; },
    sendImage: async (...args) => { sent.push({ type: 'image', args }); return { message_id: 'sent-' + sent.length }; }
  };
  media.start(qq);
  const bot = new Companion(config, settings, qq, codex, { media, now: () => time, random: () => 0.2 });
  t.after(async () => { await bot.close(); await media.close(); for (let i = 0; i < 300 && (bot.running.size || media.working); i++) await pause(10); rmSync(runtime, { recursive: true, force: true }); });
  return { runtime, config, settings, media, bot, qq, codex, calls, sent, now: () => time, advance: n => { time += n; }, reply: value => { reply = value; } };
}
function message(id, text, { at = true, images = [] } = {}) {
  return { post_type: 'message', message_type: 'group', group_id: 11111, user_id: 33333, self_id: 99999, message_id: id, sender: { nickname: '群友' }, message: [...(at ? [{ type: 'at', data: { qq: '99999' } }] : []), { type: 'text', data: { text } }, ...images.map(data => ({ type: 'image', data }))] };
}
async function flush(bot) {
  for (const timer of bot.timers.values()) clearTimeout(timer); bot.timers.clear(); bot.drain();
  for (let i = 0; i < 500 && bot.running.size; i++) await pause(5);
  assert.equal(bot.running.size, 0, 'chat completed');
}

test('private stickers use immediate vision and separate sends, ordinary pictures require an explicit request', async t => {
  const f = fixture(t, { allowedUsers: ['33333'] }); const downloads = [];
  f.media.fetchImage = async url => { downloads.push(url); return pic(downloads.length * 30); };
  const privateMessage = (id, text, images) => ({ ...message(id, text, { at: false, images }), message_type: 'private', group_id: undefined });
  await f.bot.accept(privateMessage('ordinary', '', [{ url: 'https://qpic.cn/screenshot' }])); await flush(f.bot);
  assert.equal(f.calls.length, 0); assert.equal(downloads.length, 0); assert.equal(f.sent.length, 0);
  await f.bot.accept(privateMessage('explicit', '看看刚才那张图', [])); await flush(f.bot);
  assert.equal(downloads.length, 1); assert.equal(f.calls.find(c => c.prompt.direct).options.imagePaths.length, 1);
  const item = await f.media.import(await pic(180), { kind: 'sticker', roomKey: 'private:33333' }); await f.media.waitFor([item.id]);
  assert.equal(f.media.eligible(item, 'group:11111'), false); assert.equal(f.media.eligible(item, 'private:44444'), false);
  f.calls.length = 0; f.sent.length = 0;
  await f.bot.accept(privateMessage('sticker', '哈哈', [{ url: 'https://qpic.cn/sticker', sub_type: 1 }])); await flush(f.bot);
  const chat = f.calls.find(c => c.prompt.direct); assert.ok(chat); assert.equal(chat.options.imagePaths.length, 1);
  assert.deepEqual(f.sent.map(s => s.type), ['text', 'image']);
  assert.ok(f.sent.every(s => s.args[0] === 'private' && s.args[1] === '33333'));
  assert.equal(f.sent[0].args[3], undefined);
});
test('first import tags once; duplicate bytes, renames and metadata changes reuse local recognition', async t => {
  const f = fixture(t), bytes = await pic();
  const [a, b] = await Promise.all([f.media.import(bytes, { name: 'a.png' }), f.media.import(bytes, { name: 'renamed.png' })]);
  await f.media.waitFor([a.id]); assert.equal(a.id, b.id); assert.equal(f.calls.length, 1); assert.equal(a.status, 'ready');
  const metadataOnly = await imageProcessor()(bytes).withMetadata({ density: 72 }).png().toBuffer();
  const c = await f.media.import(metadataOnly); assert.equal(c.id, a.id); assert.equal(f.calls.length, 1);
  assert.deepEqual(a.tags, ['开心', '赞同']); assert.equal(a.ocr, '好呀');
  assert.ok(existsSync(join(f.config.textRoot, 'media-library.json'))); assert.ok(f.media.original(a).includes('stickers'));
  assert.equal(f.media.retry(a.id).status, 'ready'); assert.equal(f.calls.length, 1);
});
test('cache survives restart and preserves tags, original image, provenance and favorite', async t => {
  const f = fixture(t); writeFileSync(join(f.media.paths.images, 'references', 'gpt.png'), await pic());
  f.codex.ask = async (room, prompt, timeout, options) => { f.calls.push('vision'); return options.outputSchema.properties.matches ? JSON.stringify({ matches: [{ name: 'GPT龙娘', verdict: 'yes', evidence: '独有龙角与衣装匹配' }] }) : vision({ kind: 'image', dragon: 'yes', tags: ['白发', '龙角'] }); };
  const bytes = await pic(200), item = await f.media.import(bytes, { roomKey: 'group:11111' }); await f.media.waitFor([item.id]);
  assert.equal(item.favorite, true); assert.equal(item.enabled, true); assert.ok(f.media.original(item).includes('images')); assert.ok(item.tags.includes('GPT龙娘'));
  await f.media.close();
  const restored = new MediaLibrary(f.config, f.settings, f.codex); restored.start(f.qq);
  const repeated = await restored.import(bytes, { roomKey: 'group:22222' }); assert.equal(repeated.id, item.id); assert.equal(f.calls.length, 2);
  assert.deepEqual(repeated.rooms, ['group:11111', 'group:22222']); await restored.close();
});
test('latest five new image sources are read; cached sources do not consume the five slots', async t => {
  const f = fixture(t); const downloaded = [];
  f.media.fetchImage = async url => { const n = Number(new URL(url).pathname.slice(1)); downloaded.push(n); return pic(n * 20); };
  const messages = Array.from({ length: 8 }, (_, i) => ({ time: 1000 + i, seq: i + 1, imageRefs: f.media.register([{ type: 'image', data: { url: 'https://qpic.cn/' + i, sub_type: 1 } }]) }));
  await f.media.prepareRecent([messages[7]], 'group:11111'); assert.deepEqual(downloaded, [7]);
  downloaded.length = 0;
  await f.media.prepareRecent(messages, 'group:11111'); assert.deepEqual(downloaded.sort(), [2, 3, 4, 5, 6]);
  await f.media.waitFor(Object.keys(f.media.state.items));
  assert.equal(f.calls.length, 6); assert.equal(f.media.describeMessage(messages[0]).unreadImages, 1);
  assert.equal(f.media.describeMessage(messages[7]).images[0].status, 'ready');
});

test('manual disabling during recognition survives automatic dragon collection', async t => {
  const f = fixture(t); let finish;
  f.codex.ask = () => new Promise(resolve => { finish = resolve; });
  const item = await f.media.import(await pic());
  f.media.update(item.id, { enabled: false });
  for (let i = 0; !finish && i < 100; i++) await pause(1);
  finish(vision({ dragon: 'yes' })); await f.media.waitFor([item.id]);
  assert.equal(item.favorite, true); assert.equal(item.enabled, false);
  assert.equal(f.media.candidates('group:11111').length, 0);
});

test('chat sees the actual sticker and replies while an existing WD job is still blocked', async t => {
  const f = fixture(t, { mediaReplyChance: 0 }); let releaseWd, startedWd;
  const blocked = new Promise(resolve => { releaseWd = resolve; });
  const started = new Promise(resolve => { startedWd = resolve; });
  f.media.wd.predict = async () => { startedWd(); await blocked; return { available: false, candidates: [] }; };
  const bytes = await pic(145), item = await f.media.import(bytes, { kind: 'sticker' }); await started;
  f.media.fetchImage = async () => bytes;
  f.reply({ action: 'reply', interest: 'normal', messages: ['这表情笑得好开心'], mediaId: '', memory: '', glossary: [] });
  try {
    await f.bot.accept(message(50, '哈哈', { images: [{ url: 'https://qpic.cn/live', sub_type: 1 }] })); await flush(f.bot);
    assert.equal(f.sent.length, 1); assert.equal(item.status, 'analyzing');
    assert.equal(f.calls.length, 1, 'only foreground chat ran');
    assert.deepEqual(f.calls[0].options.imagePaths, [f.media.preview(item)]);
    assert.equal(f.calls[0].prompt.imageAttachments[0].id, item.id);
    assert.equal(f.calls[0].prompt.recentMessages[0].images[0].status, 'analyzing');
    assert.equal(f.media.chatReaders, 0);
  } finally { releaseWd(); await f.media.waitFor([item.id]); }
  assert.equal(item.status, 'ready'); assert.equal(f.calls.length, 2, 'labels finish after chat');
});

test('new sticker labeling starts after the reply and duplicate stickers reuse the completed labels', async t => {
  const f = fixture(t, { mediaReplyChance: 0 }); f.media.fetchImage = async () => pic(144);
  f.reply({ action: 'reply', interest: 'normal', messages: ['笑死'], mediaId: '', memory: '', glossary: [] });
  const originalAsk = f.codex.ask;
  f.codex.ask = (...args) => { if (!args[3].outputSchema.properties.action) assert.equal(f.sent.length, 1); return originalAsk(...args); };
  const images = [{ url: 'https://qpic.cn/sticker', sub_type: '1' }];
  await f.bot.accept(message(51, '哈哈', { images })); await flush(f.bot);
  const item = Object.values(f.media.state.items)[0]; await f.media.waitFor([item.id]);
  assert.ok(f.calls[0].options.imagePaths.length); assert.equal(item.status, 'ready');
  await f.bot.accept(message(52, '哈哈', { images })); await flush(f.bot);
  assert.equal(f.calls.filter(c => !c.options.outputSchema.properties.action).length, 1);
  assert.equal(f.calls.at(-1).options.imagePaths.length, 0);
  assert.equal(f.calls.at(-1).prompt.directedMessages[0].images[0].status, 'ready');
});

test('ordinary pictures and screenshots are ignored even when mentioned or already cached', async t => {
  const f = fixture(t, { mediaReplyChance: 0 }); let fetched = 0;
  f.media.fetchImage = async () => { fetched++; return pic(125); };
  f.reply({ action: 'reply', interest: 'normal', messages: ['在呢'], mediaId: '', memory: '', glossary: [] });
  await f.bot.accept(message(53, '你好', { images: [{ url: 'https://qpic.cn/screenshot', sub_type: 0 }] })); await flush(f.bot);
  assert.equal(fetched, 0); assert.equal(f.media.summary().total, 0); assert.equal(f.sent.length, 1);
  assert.deepEqual(f.calls[0].options.imagePaths, []); assert.deepEqual(f.calls[0].prompt.directedMessages[0].images, []);
  const item = await f.media.import(await pic(125)); await f.media.waitFor([item.id]);
  const refs = f.media.register([{ type: 'image', data: { url: 'https://qpic.cn/cached-photo' } }]);
  f.media.state.sources[refs[0]] = item.id;
  const record = { id: 'cached', time: 10, seq: 1, text: '大家好', imageRefs: refs };
  const prepared = await f.media.prepareRecent([record], 'group:11111');
  assert.equal(prepared.imagePaths.length, 0); assert.deepEqual(f.media.describeMessage(record, prepared).images, []);
  assert.equal(fetched, 0);
});

test('an explicit screenshot request goes directly to chat without WD, reference or web classification', async t => {
  const f = fixture(t, { mediaReplyChance: 0 }); f.media.fetchImage = async () => pic(121);
  let classified = 0; f.media.wd.predict = async () => { classified++; throw Error('must not run'); };
  f.media.lookup.search = async () => { classified++; throw Error('must not run'); };
  f.reply({ action: 'reply', interest: 'normal', messages: ['这是你指定的截图'], mediaId: '', memory: '', glossary: [] });
  await f.bot.accept(message(54, '看看这张截图', { images: [{ url: 'https://qpic.cn/requested', sub_type: 0 }] })); await flush(f.bot);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].options.imagePaths.length, 1);
  assert.equal(f.calls[0].prompt.imageAttachments[0].explicitlyRequested, true);
  const item = Object.values(f.media.state.items)[0]; assert.equal(item.status, 'unclassified'); assert.equal(item.kind, 'image');
  assert.equal(classified, 0); assert.equal(f.media.tasks.size, 0); assert.ok(existsSync(f.media.original(item)));
  assert.equal(f.media.candidates('group:11111').length, 0);
});

test('quoted and preceding image requests read only the selected message, not all recent photos', async t => {
  const f = fixture(t, { mediaReplyChance: 0 }), downloaded = [];
  f.media.fetchImage = async url => { downloaded.push(new URL(url).pathname); return pic(downloaded.length * 40); };
  f.reply({ action: 'reply', interest: 'normal', messages: ['看到了'], mediaId: '', memory: '', glossary: [] });
  await f.bot.accept(message(55, '', { at: false, images: [{ url: 'https://qpic.cn/selected' }] }));
  await f.bot.accept(message(56, '', { at: false, images: [{ url: 'https://qpic.cn/unrelated' }] }));
  const quoted = message(57, '帮我看看'); quoted.message.unshift({ type: 'reply', data: { id: '55' } });
  await f.bot.accept(quoted); await flush(f.bot); assert.deepEqual(downloaded, ['/selected']);
  await f.bot.accept(message(58, '看看上一张图')); await flush(f.bot);
  assert.deepEqual(downloaded, ['/selected', '/unrelated']);
  assert.equal(f.calls.at(-1).options.imagePaths.length, 1);
});

test('plain image-only traffic cannot trigger active chatting or scheduled check-ins', async t => {
  const f = fixture(t, { mode: 'social', activeReplyChance: 100 });
  const room = f.bot.room('group', '11111'); room.activeUntil = f.now() + 60000;
  await f.bot.accept(message(59, '', { at: false, images: [{ url: 'https://qpic.cn/ignored' }] })); await flush(f.bot);
  assert.equal(f.calls.length, 0); assert.equal(f.bot.freshActivity(room).length, 0); assert.equal(f.media.summary().total, 0);
});

test('disabling vision prevents explicit images from being read or attached', async t => {
  const f = fixture(t, { visionEnabled: false, mediaReplyChance: 0 }); let fetched = 0;
  f.media.fetchImage = async () => { fetched++; return pic(); };
  f.reply({ action: 'reply', interest: 'normal', messages: ['在呢'], mediaId: '', memory: '', glossary: [] });
  await f.bot.accept(message(60, '看看这张图', { images: [{ url: 'https://qpic.cn/off' }] })); await flush(f.bot);
  assert.equal(fetched, 0); assert.deepEqual(f.calls[0].options.imagePaths, []); assert.equal(f.media.chatReaders, 0);
});

test('ordinary-image caches do not resume automatic classification on restart but can later arrive as stickers', async t => {
  const f = fixture(t); const bytes = await pic(118); f.media.fetchImage = async () => bytes;
  const item = await f.media.capture({ url: 'https://qpic.cn/photo', sub_type: 0 }, 'group:11111');
  assert.equal(item.status, 'unclassified'); assert.equal(f.calls.length, 0);
  // Simulate an ordinary image left waiting by the older automatic pipeline.
  item.status = 'pending'; item.analysisRequested = false; f.media.save(); await f.media.close();
  const restored = new MediaLibrary(f.config, f.settings, f.codex, { fetchImage: async () => bytes }); restored.start(f.qq);
  try {
    assert.equal(restored.get(item.id).status, 'unclassified'); assert.equal(restored.tasks.size, 0);
    const sticker = await restored.capture({ url: 'https://qpic.cn/sticker-again', sub_type: 1 }, 'group:11111');
    await restored.waitFor([sticker.id]); assert.equal(sticker.id, item.id); assert.equal(sticker.status, 'ready');
    assert.equal(sticker.kind, 'sticker'); assert.equal(f.calls.length, 1);
  } finally { await restored.close(); }
});

test('background processing waits for every concurrent chat and resumes after both release', async t => {
  const f = fixture(t); const releaseA = f.media.beginChat(), releaseB = f.media.beginChat();
  const item = await f.media.import(await pic(117), { kind: 'sticker' });
  assert.equal(f.calls.length, 0); releaseA(); releaseA(); await pause(5); assert.equal(f.calls.length, 0);
  releaseB(); await f.media.waitFor([item.id]); assert.equal(item.status, 'ready'); assert.equal(f.calls.length, 1); assert.equal(f.media.chatReaders, 0);
});
test('caption is one text message followed by a separate image; repeat cooldown is per room', async t => {
  const f = fixture(t); const item = await f.media.import(await pic()); await f.media.waitFor([item.id]);
  await f.bot.accept(message(1, '好开心')); await flush(f.bot);
  assert.deepEqual(f.sent.map(s => s.type), ['text', 'image']); assert.equal(f.sent[0].args[2], '哈哈\n就是这样');
  assert.equal(f.media.candidates('group:11111').length, 0); assert.equal(f.media.candidates('group:22222').length, 1);
  f.advance(30 * 60000); assert.equal(f.media.candidates('group:11111').length, 1);
});
test('image-only reply counts as a reply and opens the active window', async t => {
  const f = fixture(t, { mode: 'social' }); const item = await f.media.import(await pic()); await f.media.waitFor([item.id]);
  f.reply({ action: 'reply', interest: 'normal', messages: [], mediaId: item.id, memory: '', glossary: [] });
  await f.bot.accept(message(1, '发表情')); await flush(f.bot);
  assert.deepEqual(f.sent.map(s => s.type), ['image']); assert.ok(f.bot.room('group', '11111').activeUntil > f.now());
});

test('a mention accompanies the caption while the image is still sent separately', async t => {
  const f = fixture(t), item = await f.media.import(await pic()); await f.media.waitFor([item.id]);
  f.qq.call = async () => [{ user_id: 33333 }];
  f.reply({ action: 'reply', interest: 'normal', messages: ['看这里'], mediaId: item.id, mention: { mode: 'selected', targets: ['33333'] }, memory: '', glossary: [] });
  await f.bot.accept(message(1, '叫我看图')); await flush(f.bot);
  assert.deepEqual(f.sent.map(s => s.type), ['text', 'image']); assert.deepEqual(f.sent[0].args[4], ['33333']);
});
test('unknown media IDs and probability zero cannot send arbitrary files or bypass @ reply', async t => {
  const f = fixture(t, { mediaReplyChance: 0 }); const item = await f.media.import(await pic()); await f.media.waitFor([item.id]);
  f.reply({ action: 'reply', interest: 'normal', messages: [], mediaId: item.id, memory: '', glossary: [] });
  await f.bot.accept(message(1, '被叫到')); await flush(f.bot); assert.deepEqual(f.sent.map(s => s.type), ['text']);
  f.settings.update({ mediaReplyChance: 100 }); f.reply({ action: 'reply', interest: 'normal', messages: [], mediaId: 'C:/secret.png', memory: '', glossary: [] });
  await f.bot.accept(message(2, '再问')); await flush(f.bot); assert.deepEqual(f.sent.map(s => s.type), ['text', 'text']);
});
test('ordinary photos stay private to their source room and disabled until explicitly enabled', async t => {
  const f = fixture(t); f.codex.ask = async () => vision({ kind: 'image' });
  const item = await f.media.import(await pic(), { roomKey: 'group:11111' }); await f.media.waitFor([item.id]);
  assert.equal(item.enabled, false); assert.equal(f.media.candidates('group:22222').length, 0);
  f.media.update(item.id, { enabled: true }); assert.equal(f.media.candidates('group:11111').length, 1); assert.equal(f.media.candidates('group:22222').length, 0);
  f.media.update(item.id, { shared: true, tags: ['新标签'], kind: 'sticker' }); assert.equal(f.media.candidates('group:22222').length, 1);
  assert.ok(existsSync(f.media.original(item))); assert.deepEqual(item.tags, ['新标签']);
});
test('resting chats do not register or fetch image sources', async t => {
  const f = fixture(t, { mode: 'social' });
  await f.bot.accept(message(1, '', { at: false, images: [{ url: 'https://qpic.cn/1' }] }));
  assert.equal(f.media.sources.size, 0); assert.equal(f.media.summary().total, 0); assert.equal(f.calls.length, 0);
});
test('untrusted URLs, local-file message paths, invalid files and cancelled downloads are rejected', async t => {
  const f = fixture(t);
  for (const url of ['http://127.0.0.1/x', 'file:///C:/secret', 'https://qpic.cn.evil.test/a', 'https://a@qpic.cn/x', 'http://qq.com:3100/x']) assert.equal(imageUrlAllowed(url), false);
  assert.equal(imageUrlAllowed('https://multimedia.nt.qq.com.cn/download?fileid=abc'), true);
  // qq.com.cn is a separate QQ CDN domain, explicitly handled in the application allowlist.
  await assert.rejects(f.media.capture({ file: 'C:/secret.png' }, 'group:11111'));
  await assert.rejects(f.media.import(Buffer.from('<svg></svg>')));
  await assert.rejects(f.media.import(Buffer.alloc(13 * 1024 * 1024)));
  let cancelled = false; f.media.fetchImage = async () => { cancelled = true; return pic(); };
  const item = await f.media.capture({ url: 'https://qpic.cn/cancel' }, 'group:11111', { isCancelled: () => cancelled });
  assert.equal(item, null); assert.equal(f.media.summary().total, 0);
});
test('recognition failure keeps original; manual retry works and ready images never re-run', async t => {
  const f = fixture(t); f.codex.ask = async () => { throw Error('temporary'); };
  const item = await f.media.import(await pic()); await f.media.waitFor([item.id]);
  assert.equal(item.status, 'failed'); assert.ok(existsSync(f.media.original(item)));
  f.codex.ask = async () => vision(); f.media.retry(item.id); await f.media.waitFor([item.id]); assert.equal(item.status, 'ready');
});
test('GIF keeps original animation and creates sampled frames for a single vision call', async t => {
  const f = fixture(t);
  const raw = Buffer.alloc(16 * 32 * 4, 255); raw.fill(0, 16 * 16 * 4);
  const gif = await imageProcessor()(raw, { raw: { width: 16, height: 32, channels: 4, pageHeight: 16 } }).gif({ delay: [100, 100], loop: 0 }).toBuffer();
  const inspected = await inspectImage(gif); assert.equal(inspected.pages, 2); assert.equal(inspected.previews.length, 2);
  const item = await f.media.import(gif); await f.media.waitFor([item.id]); assert.deepEqual(readFileSync(f.media.original(item)), gif); assert.equal(f.calls.length, 1); assert.equal(f.calls[0].options.imagePaths.length, 2);
});

test('animations with different timing are not merged by identical sampled pixels', async t => {
  const f = fixture(t), raw = Buffer.alloc(16 * 32 * 4, 255); raw.fill(0, 16 * 16 * 4);
  const make = delay => imageProcessor()(raw, { raw: { width: 16, height: 32, channels: 4, pageHeight: 16 } }).gif({ delay, loop: 0 }).toBuffer();
  const first = await f.media.import(await make([100, 100]));
  const second = await f.media.import(await make([900, 100]));
  await f.media.waitFor([first.id, second.id]); assert.notEqual(first.id, second.id);
});
test('media APIs require authentication and persist uploads, tag edits, previews and settings', async t => {
  const f = fixture(t), server = createConsole(f.settings, f.bot, f.qq); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = 'http://127.0.0.1:' + server.address().port, headers = { Authorization: 'Bearer ' + f.settings.token };
  assert.equal((await fetch(base + '/api/media')).status, 401);
  const uploaded = await fetch(base + '/api/media/upload', { method: 'POST', headers, body: JSON.stringify({ base64: (await pic()).toString('base64'), kind: 'sticker', tags: ['测试'] }) });
  assert.equal(uploaded.status, 200); const item = await uploaded.json(); await f.media.waitFor([item.id]);
  assert.equal((await fetch(base + '/api/media/file?id=' + item.id)).status, 401);
  assert.equal((await fetch(base + '/api/media/file?id=../../secret', { headers })).status, 404);
  const preview = await fetch(base + '/api/media/file?id=' + item.id, { headers }); assert.equal(preview.headers.get('content-type'), 'image/png');
  const update = await fetch(base + '/api/media/update', { method: 'POST', headers, body: JSON.stringify({ id: item.id, tags: ['喜欢'], enabled: false }) }); assert.equal(update.status, 200);
  const list = await (await fetch(base + '/api/media?q=' + encodeURIComponent('喜欢'), { headers })).json(); assert.equal(list.items.length, 1); assert.equal(list.items[0].enabled, false);
});
test('record migration copies existing state without replacing a newer store', t => {
  const f = fixture(t); const source = join(f.runtime, 'companion.json'); writeFileSync(source, '{"version":1}');
  writeFileSync(join(f.runtime, 'server.log'), 'old server log');
  prepareRecords(f.config); const target = join(f.config.textRoot, 'companion.json'); const before = readFileSync(target, 'utf8');
  assert.equal(readFileSync(join(f.config.textRoot, 'legacy-server.log'), 'utf8'), 'old server log');
  writeFileSync(join(f.runtime, 'server.log'), 'newer server log');
  writeFileSync(source, '{"version":2}'); prepareRecords(f.config); assert.equal(readFileSync(target, 'utf8'), before); assert.ok(existsSync(source));
  assert.equal(readFileSync(join(f.config.textRoot, 'legacy-server.log'), 'utf8'), 'old server log');
});
test('OneBot sends an image-only segment and Codex attaches explicit local image inputs', async () => {
  const qq = new OneBotClient(() => {}); let call;
  qq.call = async (action, params) => { call = { action, params }; return {}; };
  await qq.sendImage('group', '11111', 'F:/botRecord/img/stickers/test.gif', { sticker: true });
  assert.equal(call.params.message.length, 1); assert.equal(call.params.message[0].type, 'image'); assert.equal(call.params.message[0].data.sub_type, 1); assert.match(call.params.message[0].data.file, /^file:\/\/\/F:/);
  const client = new CodexClient({ effort: 'high' }); client.prepare = async room => { room.threadId = 'test'; };
  client.call = async (method, params) => { call = { method, params }; queueMicrotask(() => { client.onMessage({ method: 'item/completed', params: { threadId: 'test', item: { type: 'agentMessage', text: '{}' } } }); client.onMessage({ method: 'turn/completed', params: { threadId: 'test', turn: { status: 'completed' } } }); }); return { turn: { id: 'turn' } }; };
  await client.ask({}, '识图', 1000, { imagePaths: ['F:/botRecord/img/a.png'], effort: 'low' });
  assert.equal(call.params.input[1].type, 'localImage'); assert.equal(call.params.effort, 'low'); assert.equal(client.active.size, 0);
});
