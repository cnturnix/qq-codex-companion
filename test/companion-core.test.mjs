import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join, sep } from 'node:path';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { Settings } from '../src/companion-settings.mjs';
import { Companion } from '../src/companion.mjs';
import { CompanionCore } from '../src/companion-core/core.mjs';
import { MemoryStore } from '../src/companion-core/store.mjs';
import { completedTurn } from '../src/companion-core/event-adapter.mjs';
import { eventId } from '../src/companion-core/policy.mjs';
import { createConsole } from '../src/console-server.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
const reply = () => JSON.stringify({ action: 'reply', interest: 'normal', messages: ['收到啦'], mediaId: '', mention: { mode: 'none', targets: [] }, memory: '', glossary: [] });
function fixture(t, settingsPatch = {}) {
  mkdirSync(resolve('work'), { recursive: true }); const runtime = mkdtempSync(join(resolve('work'), 'core-test-'));
  const settings = new Settings(runtime); settings.update({ allowedGroups: ['11111', '22222'], allowedUsers: ['33333', '44444'], mode: 'chat', ...settingsPatch });
  let time = 1792713600000; const asks = [], sends = [], qqCalls = []; let extraction;
  const qq = { identity: { id: '99999' }, connected: true, status: () => ({ connected: true }), call: async (method, params) => { qqCalls.push({ method, params }); return { messages: [] }; },
    send: async (...args) => { sends.push(args); return { message_id: 'out-' + sends.length }; } };
  const codex = { ready: true, resumed: new Set(), interrupt: async () => {}, ask: async (room, prompt, timeout, options) => {
    const data = JSON.parse(prompt); asks.push({ data, options }); room.threadId = 'thread-' + asks.length;
    return options.outputSchema.properties.memories ? JSON.stringify(extraction ? extraction(data) : { memories: [] }) : reply();
  } };
  const config = { runtime, model: 'test', effort: 'high' }; const bot = new Companion(config, settings, qq, codex, { now: () => time, random: () => .1 });
  const core = new CompanionCore(config, settings, codex, bot, { now: () => time }); bot.core = core;
  t.after(async () => { await bot.close(); await core.close(); assert.ok(runtime.startsWith(resolve('work') + sep)); rmSync(runtime, { recursive: true, force: true }); });
  return { runtime, settings, config, bot, core, store: core.store, qq, codex, asks, sends, qqCalls, now: () => time, advance: n => { time += n; }, extraction: fn => { extraction = fn; } };
}
function message(id, text = '本群周末一起玩星露谷', { at = true, group = '11111', privateChat = false, sender = '33333', time } = {}) {
  return { post_type: 'message', message_type: privateChat ? 'private' : 'group', group_id: group, user_id: sender, self_id: '99999', message_id: String(id), time,
    message: [...(at && !privateChat ? [{ type: 'at', data: { qq: '99999' } }] : []), { type: 'text', data: { text } }] };
}
async function flush(f) {
  for (const timer of f.bot.timers.values()) clearTimeout(timer); f.bot.timers.clear(); f.bot.drain();
  for (let i = 0; i < 500 && f.bot.running.size; i++) await tick(); assert.equal(f.bot.running.size, 0);
  await Promise.all([...f.core.pendingCaptures]);
}
function candidate(data, patch = {}) { return { scope: data.scope, type: 'semantic', text: '本群周末一起玩星露谷', canonical_key: 'weekend.game', evidence_ids: [data.events.find(e => e.actor === 'human').id], confidence: .9, importance: .8, ...patch }; }
async function learn(f, id = 1, patch = {}) {
  f.core.updateSettings({ candidateExtractionEnabled: true, ...patch });
  f.extraction(data => ({ memories: [candidate(data)] }));
  await f.bot.accept(message(id)); await flush(f); f.core.extract(); await f.core.running?.promise;
  return f.store.list().items[0];
}
function confirm(f, memory) { f.core.updateSettings({ learningDryRun: false, globalMemoryEnabled: true }); f.store.updateMemory(memory.id, { status: 'active' }); }

test('new learning defaults off and never record or call a second model until enabled', async t => {
  const f = fixture(t); await f.bot.accept(message(1)); await flush(f); f.core.pump();
  assert.equal(f.store.summary().events, 0); assert.equal(f.asks.length, 1); assert.equal(f.core.summary().settings.learningDryRun, true);
  assert.equal('learnedMemories' in f.asks[0].data, false);
});
test('successful turns persist once, with assistant evidence kept distinct and replay blocked', async t => {
  const f = fixture(t); f.core.updateSettings({ candidateExtractionEnabled: true });
  await f.bot.accept(message(1)); await flush(f); const count = f.store.summary().events;
  await f.bot.accept(message(1)); await flush(f); assert.equal(f.store.summary().events, count);
  const rows = f.store.all('SELECT * FROM events'); assert.deepEqual(rows.map(e => e.actor).sort(), ['assistant', 'human']);
  assert.equal(rows.find(e => e.actor === 'human').actor_ref, 'qq:33333');
  assert.equal(rows.find(e => e.actor === 'assistant').actor_ref, null);
  const turn = completedTurn({ room: f.bot.room('group', '11111'), job: { direct: true }, messages: [{ id: '1', sender: '33333', text: '本群周末一起玩星露谷', time: f.now() }], outputs: [{ id: 'different', text: '重试' }], now: f.now() });
  assert.equal(f.store.capture(turn), false); assert.equal(f.store.all('SELECT * FROM turns').length, 1);
});
test('model failure, fallback, send failure, and cancelled replies cannot create learning evidence', async t => {
  const f = fixture(t); f.core.updateSettings({ candidateExtractionEnabled: true });
  f.codex.ask = async () => { throw Error('model failed'); }; await f.bot.accept(message(1)); await flush(f);
  assert.equal(f.sends.length, 1); assert.equal(f.store.summary().events, 0);
  f.codex.ask = async () => reply(); f.qq.send = async () => { throw Error('send failed'); };
  await f.bot.accept(message(2)); await flush(f); assert.equal(f.store.summary().events, 0);
  f.codex.ask = async () => { await f.bot.stop('group:11111'); return reply(); };
  await f.bot.accept(message(3)); await flush(f); assert.equal(f.store.summary().events, 0);
});
test('resting messages never enter learning; mentions use only the original 30-message history', async t => {
  const f = fixture(t, { mode: 'social', checkinReplyChance: 0, activeReplyChance: 0 }); f.core.updateSettings({ candidateExtractionEnabled: true });
  await f.bot.accept(message(1, '未读取内容', { at: false })); await flush(f); assert.equal(f.store.summary().events, 0); assert.equal(f.qqCalls.length, 0);
  f.qq.call = async (method, params) => { f.qqCalls.push({ method, params }); return { messages: Array.from({ length: 80 }, (_, i) => message('h' + i, '历史消息' + i, { at: false, time: f.now() / 1000 - 80 + i })) }; };
  await f.bot.accept(message(2)); await flush(f);
  assert.deepEqual(f.qqCalls.map(c => c.params.count), [30]); assert.ok(f.store.all("SELECT * FROM events WHERE actor='human'").length <= 30);
  assert.equal(f.store.all("SELECT * FROM events WHERE content LIKE '%未读取内容%'").length, 0);
});
test('scheduled appearances retain the single 50-message read and do not learn unchosen drafts', async t => {
  const f = fixture(t, { mode: 'social', interestAdjustment: false, checkinReplyChance: 0 }); f.core.updateSettings({ candidateExtractionEnabled: true });
  f.advance(f.bot.room('group', '11111').nextCheckAt - f.now());
  f.qq.call = async (method, params) => { f.qqCalls.push({ method, params }); return { messages: [message('h1', '讨论游戏', { at: false, time: f.now() / 1000 })] }; };
  await f.bot.checkPresence(); await flush(f);
  assert.ok(f.qqCalls.every(c => c.method === 'get_group_msg_history' && c.params.count === 50));
  assert.equal(f.store.summary().events, 0); assert.equal(f.sends.length, 0);
});
test('batch candidates require actual human evidence and reject invented IDs, assistant claims and cross-scope promotion', async t => {
  const f = fixture(t); f.core.updateSettings({ candidateExtractionEnabled: true });
  f.extraction(data => ({ memories: [candidate(data), candidate(data, { evidence_ids: ['invented'] }), candidate(data, { evidence_ids: [data.events.find(e => e.actor === 'assistant').id] }), candidate(data, { scope: 'persona' }), candidate(data, { scope: 'relationship' })] }));
  await f.bot.accept(message(1)); await flush(f); f.core.extract(); await f.core.running?.promise;
  assert.equal(f.store.list().total, 1); const memory = f.store.list().items[0]; assert.equal(memory.scope, 'room'); assert.equal(memory.status, 'candidate');
  assert.equal(f.store.memory(memory.id).evidence[0].actor, 'human'); assert.match(f.store.summary().recentAudit[0].detail, /rejected=4/);
});
test('only reviewed relevant memories enter all allowed groups and private chats with provenance', async t => {
  const f = fixture(t); const memory = await learn(f);
  assert.throws(() => f.store.updateMemory(memory.id, { status: 'active' }), /试运行/);
  assert.equal(f.core.context(f.bot.room('group', '11111'), '星露谷').memories.length, 0);
  confirm(f, memory); assert.equal(f.core.context(f.bot.room('group', '11111'), '星露谷').memories.length, 1);
  assert.equal(f.core.context(f.bot.room('group', '22222'), '星露谷').memories.length, 1);
  assert.equal(f.core.context(f.bot.room('private', '33333'), '星露谷').memories[0].source, 'group:11111');
  assert.equal(f.core.context(f.bot.room('group', '55555'), '星露谷').memories.length, 0);
  assert.equal(f.core.context(f.bot.room('group', '11111'), '量子力学').memories.length, 0);
  await f.bot.accept(message(2, '星露谷周末还玩吗')); await flush(f);
  assert.equal(f.asks.at(-1).data.learnedMemories.length, 1); assert.equal(f.asks.at(-1).data.recentMessages.filter(m => !m.bot).length, 1);
  const { learnedMemories, learnedMemoryRules } = f.asks.at(-1).data;
  assert.ok(Buffer.byteLength(JSON.stringify({ learnedMemories, learnedMemoryRules })) <= f.store.settings().maxExtraPromptTokens);
});
test('private relationships must be verified by the actual private route, never by a group sender', async t => {
  const f = fixture(t); f.core.updateSettings({ candidateExtractionEnabled: true, learningDryRun: false, globalMemoryEnabled: true });
  assert.throws(() => f.core.addMemory({ scope: 'relationship', scopeKey: 'qq:33333', text: '我喜欢星露谷', canonicalKey: 'game' }), /验证/);
  await f.bot.accept(message(1, '我喜欢星露谷', { privateChat: true })); await flush(f);
  const memory = f.core.addMemory({ scope: 'relationship', scopeKey: 'qq:33333', text: '对方喜欢星露谷', canonicalKey: 'game' }); f.store.updateMemory(memory.id, { status: 'active' });
  assert.equal(f.core.context(f.bot.room('private', '33333'), '星露谷').memories.length, 1);
  assert.equal(f.core.context(f.bot.room('private', '44444'), '星露谷').memories.length, 1);
  assert.equal(f.store.search({ roomKey: 'group:11111', principal: 'qq:33333', query: '星露谷' })[0].source, 'qq:33333');
});
test('explicit nonprivate persona settings can be shared but private_local notes never reach chat', t => {
  const f = fixture(t); f.core.updateSettings({ learningDryRun: false, globalMemoryEnabled: true });
  for (const scope of ['persona', 'private_local']) { const m = f.core.addMemory({ scope, text: scope === 'persona' ? '公共游戏设定：喜欢星露谷话题' : '星露谷私人审核备注', canonicalKey: 'game' }); f.store.updateMemory(m.id, { status: 'active' }); }
  const memories = f.core.context(f.bot.room('group', '22222'), '星露谷').memories;
  assert.equal(memories.length, 1); assert.equal(memories[0].scope, 'persona');
});
test('fact conflicts stay pending until confirmed; updating content and invalid status is atomic', t => {
  const f = fixture(t); f.core.updateSettings({ learningDryRun: false });
  const old = f.core.addMemory({ scope: 'room', scopeKey: 'group:11111', text: '星期六玩星露谷', canonicalKey: 'game.date' }); f.store.updateMemory(old.id, { status: 'active' });
  const newer = f.core.addMemory({ scope: 'room', scopeKey: 'group:11111', text: '改成星期日玩星露谷', canonicalKey: 'game.date' });
  assert.equal(newer.conflict, true); assert.equal(f.store.memory(old.id).status, 'active');
  assert.throws(() => f.store.updateMemory(newer.id, { text: '不应保存的改动', status: 'invalid' })); assert.equal(f.store.memory(newer.id).content, newer.content);
  f.store.updateMemory(newer.id, { status: 'active' }); assert.equal(f.store.memory(old.id).status, 'superseded');
  assert.equal(f.store.memory(old.id).superseded_by, newer.id);
});
test('retrieval honors a conservative prompt budget, excludes repeated summaries and keeps old permanent facts', t => {
  const f = fixture(t); f.core.updateSettings({ learningDryRun: false, globalMemoryEnabled: true });
  const m = f.core.addMemory({ scope: 'persona', text: '星露谷是共同关注的游戏话题', canonicalKey: 'game' }); f.store.updateMemory(m.id, { status: 'active' });
  f.advance(3650 * 86400000);
  assert.equal(f.store.search({ roomKey: 'group:11111', query: '星露谷', maxChars: 10 }).length, 0);
  assert.equal(f.store.search({ roomKey: 'group:11111', query: '星露谷', existing: m.content }).length, 0);
  assert.equal(f.store.search({ roomKey: 'group:11111', query: '星露谷' }).length, 1);
});
test('deletion retracts sources, related memories and old versions; tombstones survive restart and block replay', async t => {
  const f = fixture(t), memory = await learn(f); confirm(f, memory);
  const room = f.bot.room('group', '11111'); room.profile = '手动群档案'; room.memory = '星露谷自动摘要'; room.lastResult = '星露谷';
  await f.core.erase({ memoryId: memory.id });
  assert.equal(f.store.list().total, 0); assert.equal(f.store.summary().events, 0); assert.equal(room.memory, ''); assert.equal(room.history.length, 0); assert.equal(room.profile, '手动群档案');
  assert.equal(f.store.forgotten(eventId(room.key, '1')), true); const count = f.sends.length;
  await f.bot.accept(message(1)); await flush(f); assert.equal(f.sends.length, count);
  const quoted = message(2, '请再说一次'); quoted.message.unshift({ type: 'reply', data: { id: '1' } });
  await f.bot.accept(quoted); await flush(f);
  assert.equal(f.qqCalls.filter(c => c.method === 'get_msg').length, 0);
  assert.equal(JSON.stringify(f.asks.at(-1).data).includes('星露谷'), false);
  assert.equal(JSON.stringify(f.store.summary().recentAudit).includes('星露谷'), false);
  const file = f.store.file; await f.core.close(); const reopened = new MemoryStore(file);
  assert.equal(reopened.forgotten(eventId(room.key, '1')), true); assert.equal(reopened.list().total, 0); reopened.close();
});

test('account sharing persists and old independent scope requests cannot reinstate isolation', async t => {
  const f = fixture(t), memory = await learn(f); confirm(f, memory);
  assert.equal(f.store.settings().learnedPersonaScope, 'shared');
  f.core.updateSettings({ learnedPersonaScope: 'shared' });
  assert.equal(f.core.context(f.bot.room('group', '22222'), '星露谷').memories.length, 1);
  assert.throws(() => f.core.updateSettings({ learnedPersonaScope: 'room' }), /账号共享/);
  assert.throws(() => f.core.updateSettings({ learnedPersonaScope: 'anything' }), /性格/);
  const path = f.store.file; await f.core.close(); const reopened = new MemoryStore(path);
  assert.equal(reopened.settings().learnedPersonaScope, 'shared'); reopened.close();
});

test('version one migrates transactionally without inventing human identities or dropping records', async t => {
  const f = fixture(t); f.core.updateSettings({ candidateExtractionEnabled: true }); await f.bot.accept(message(1)); await flush(f);
  const count = f.store.summary().events, path = f.store.file; await f.core.close();
  const old = new DatabaseSync(path); old.exec('ALTER TABLE events DROP COLUMN actor_ref; PRAGMA user_version=1'); old.close();
  const migrated = new MemoryStore(path);
  assert.equal(migrated.get('PRAGMA user_version').user_version, 2); assert.equal(migrated.summary().events, count);
  assert.ok(migrated.all('SELECT actor_ref FROM events').every(e => e.actor_ref === null)); migrated.close();
});

test('disabled vision queues do not starve learning, while actual media work still takes priority', t => {
  const f = fixture(t, { visionEnabled: false }); f.bot.media = { working: false, tasks: new Set(['pending']), chatReaders: 0 };
  assert.equal(f.core.readyToWork(), true); f.bot.media.working = true; assert.equal(f.core.readyToWork(), false);
  f.bot.media.working = false; f.settings.update({ visionEnabled: true }); assert.equal(f.core.readyToWork(), false);
  f.bot.media = null;
});
test('persistent jobs recover once, keep consumed quotas and stop after the bounded retry limit', async t => {
  const f = fixture(t); f.core.updateSettings({ candidateExtractionEnabled: true, maxLearningCodexCallsPerHour: 1 });
  await f.bot.accept(message(1)); await flush(f); f.store.createJobs({ manual: true });
  const job = f.store.nextJob(() => true); const callId = f.store.startJob(job); assert.ok(callId); assert.equal(f.store.quota().permitted, false);
  const file = f.store.file; await f.core.close(); const reopened = new MemoryStore(file, { now: f.now });
  assert.equal(reopened.get('SELECT status,attempts FROM jobs WHERE id=?', job.id).status, 'queued');
  assert.equal(reopened.quota().permitted, false); assert.equal(reopened.get('SELECT attempts FROM jobs WHERE id=?', job.id).attempts, 1); reopened.close();
});
test('foreground chat interrupts learning without waiting for its model, and cancelled candidates never commit', async t => {
  const f = fixture(t); f.core.updateSettings({ candidateExtractionEnabled: true }); await f.bot.accept(message(1)); await flush(f);
  let finish; const original = f.codex.ask;
  f.codex.ask = async (room, prompt, timeout, options) => {
    if (!options.outputSchema.properties.memories) return original(room, prompt, timeout, options);
    room.threadId = 'learning'; const data = JSON.parse(prompt); return new Promise(resolve => { finish = () => resolve(JSON.stringify({ memories: [candidate(data)] })); });
  };
  let interrupted = false; f.codex.interrupt = async id => { if (id === 'learning') interrupted = true; };
  f.core.extract(); for (let i = 0; !finish && i < 100; i++) await tick(); assert.ok(finish);
  try {
    await f.bot.accept(message(2)); await flush(f); assert.equal(f.sends.length, 2); assert.equal(interrupted, true); assert.equal(f.store.list().total, 0);
  } finally { finish(); await f.core.running?.promise; }
  assert.equal(f.store.list().total, 0);
});
test('removed room access and disabled retention prevent delayed model results or pending captures from committing', async t => {
  const f = fixture(t); f.core.updateSettings({ candidateExtractionEnabled: true });
  await f.bot.accept(message(1)); await flush(f); let finish;
  f.codex.ask = async (room, prompt) => { const data = JSON.parse(prompt); return new Promise(resolve => { finish = () => resolve(JSON.stringify({ memories: [candidate(data)] })); }); };
  f.core.extract(); for (let i = 0; !finish && i < 100; i++) await tick();
  f.settings.update({ allowedGroups: [] }); finish(); await f.core.running?.promise;
  assert.equal(f.store.list().total, 0); assert.equal(f.core.context(f.bot.room('group', '11111'), '星露谷').memories.length, 0);
});
test('storage faults disable only new memory; mentions still reply and original state is not overwritten', async t => {
  const f = fixture(t); f.core.updateSettings({ candidateExtractionEnabled: true });
  f.store.capture = () => { throw Error('disk unavailable'); };
  await f.bot.accept(message(1)); await flush(f); assert.equal(f.core.failed, true);
  await f.bot.accept(message(2)); await flush(f); assert.equal(f.sends.length, 2);
  const invalid = join(f.runtime, 'invalid.db'); writeFileSync(invalid, 'keep original bytes');
  assert.throws(() => new MemoryStore(invalid)); assert.equal(readFileSync(invalid, 'utf8'), 'keep original bytes');
});
test('new memory routes require the same authentication and origin boundary and cannot promote scope through updates', async t => {
  const f = fixture(t), server = createConsole(f.settings, f.bot, f.qq); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = 'http://127.0.0.1:' + server.address().port, headers = { Authorization: 'Bearer ' + f.settings.token };
  assert.equal((await fetch(base + '/api/companion/memories')).status, 401);
  assert.equal((await fetch(base + '/api/companion/memories', { headers: { ...headers, Origin: 'https://bad.test' } })).status, 403);
  const created = await (await fetch(base + '/api/companion/add', { method: 'POST', headers, body: JSON.stringify({ scope: 'room', scopeKey: 'group:11111', text: '星露谷周末约定', canonicalKey: 'game' }) })).json();
  const updated = await fetch(base + '/api/companion/update', { method: 'POST', headers, body: JSON.stringify({ id: created.id, scope: 'persona', text: '星露谷周日约定' }) });
  assert.equal(updated.status, 200); assert.equal((await updated.json()).scope, 'room');
  assert.equal((await fetch(base + '/api/companion/add', { method: 'POST', headers, body: JSON.stringify({ scope: 'room', scopeKey: 'group:55555', text: '星露谷', canonicalKey: 'game' }) })).status, 400);
});
test('persona revision rejects stale saves atomically and preserves the existing editable personality', t => {
  const f = fixture(t), before = f.settings.public(); f.settings.update({ persona: '新的管理员性格设定' });
  assert.throws(() => f.settings.update({ persona: '旧窗口的内容', personaRevision: before.personaRevision, name: '不应改名' }), /性格已/);
  assert.equal(f.settings.value.persona, '新的管理员性格设定'); assert.equal(f.settings.value.name, before.name);
  f.settings.update({ persona: '手动进一步修改', personaRevision: f.settings.public().personaRevision }); assert.equal(f.settings.value.persona, '手动进一步修改');
});

test('existing summaries, profiles and glossary entries share without enabling new model learning', async t => {
  const f = fixture(t), source = f.bot.room('private', '33333');
  source.memory = '小明周六玩星露谷。'; source.profile = '小明喜欢种田游戏。'; source.glossary = [{ term: '农场队', meaning: '星露谷小队' }];
  assert.equal(f.store.settings().candidateExtractionEnabled, false);
  const before = f.core.context(f.bot.room('group', '22222'), '星露谷');
  assert.ok(before.memories.length); assert.ok(before.memories.every(m => m.source === 'private:33333'));
  assert.ok(Buffer.byteLength(JSON.stringify({ learnedMemories: before.memories, learnedMemoryRules: before.rules })) <= f.store.settings().maxExtraPromptTokens);
  await f.bot.accept(message('shared-summary', '星露谷安排是什么', { group: '22222' })); await flush(f);
  assert.ok(f.asks.at(-1).data.learnedMemories.some(m => m.content.includes('星露谷')));
  await f.bot.editRoom(source.key, { memory: '小明已经取消周末活动。', profile: '' }); source.glossary = [];
  assert.equal(f.bot.room('group', '22222').threadId, null);
  assert.equal(f.core.context(f.bot.room('group', '22222'), '星露谷').memories.length, 0);
});

test('shared records stay bound to the robot QQ account across reconnects and restart', async t => {
  const f = fixture(t), memory = await learn(f); confirm(f, memory);
  assert.equal(f.bot.state.accountId, '99999');
  f.qq.identity = { id: '88888' };
  assert.equal(f.bot.bindAccount('88888'), false); assert.equal(f.bot.snapshot().sharing.accountMatches, false);
  assert.equal(f.core.context(f.bot.room('group', '22222'), '星露谷').memories.length, 0);
  const sends = f.sends.length; await f.bot.accept({ ...message('other-account'), self_id: '88888' }); await flush(f); assert.equal(f.sends.length, sends);
  const restored = new Companion(f.config, f.settings, f.qq, f.codex); assert.equal(restored.allowed('group', '11111'), false); await restored.close();
  f.qq.identity = { id: '99999' }; assert.equal(f.bot.bindAccount('99999'), true);
  assert.equal(f.core.context(f.bot.room('group', '22222'), '星露谷').memories.length, 1);
});
